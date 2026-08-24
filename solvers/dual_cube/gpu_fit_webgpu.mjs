/**
 * Optional WebGPU residual backend for packed fit jobs.
 * JavaScript evaluateJobsCpu remains the correctness oracle.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  HEADER_BYTES,
  SAMPLE_STRIDE,
  JOB_STRIDE,
  RESULT_STRIDE,
  unpackFitBatch,
  unpackFitResults,
  packFitResults,
} from './gpu_fit_protocol.mjs';

let device = null;
let pipeline = null;
let loadState = { ok: false, reason: 'not loaded' };

export function gpuFitStatus() {
  return { ...loadState, ready: !!pipeline };
}

async function readWgsl() {
  const url = new URL('./gpu_fit.wgsl', import.meta.url);
  if (typeof process !== 'undefined' && process.versions?.node) {
    return readFileSync(fileURLToPath(url), 'utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error('failed to fetch gpu_fit.wgsl');
  return res.text();
}

export async function initGpuFitter() {
  if (pipeline) return loadState;
  const gpu = globalThis.navigator?.gpu;
  if (!gpu) {
    loadState = { ok: false, reason: 'navigator.gpu is not available' };
    return loadState;
  }
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    loadState = { ok: false, reason: 'no WebGPU adapter' };
    return loadState;
  }
  device = await adapter.requestDevice();
  const code = await readWgsl();
  const module = device.createShaderModule({ code });
  pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  loadState = {
    ok: true,
    reason: 'webgpu fitter ready',
    adapter: adapter.info?.description || adapter.name || 'adapter',
  };
  return loadState;
}

function paddedBytes(n) {
  return Math.max(256, n);
}

export async function evaluateJobsGpu(batchOrBuf) {
  if (!pipeline || !device) throw new Error('WebGPU fitter is not initialized');
  const buf = batchOrBuf instanceof ArrayBuffer ? batchOrBuf : null;
  if (!buf) throw new Error('evaluateJobsGpu expects a packed ArrayBuffer');
  const { sampleCount, jobCount } = unpackFitBatch(buf);
  if (!jobCount) return [];

  const sampleOffset = HEADER_BYTES;
  const jobOffset = HEADER_BYTES + sampleCount * SAMPLE_STRIDE;
  const sampleBytes = sampleCount * SAMPLE_STRIDE;
  const jobBytes = jobCount * JOB_STRIDE;
  const resultBytes = jobCount * RESULT_STRIDE;

  const sampleGPU = device.createBuffer({
    size: paddedBytes(sampleBytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const jobGPU = device.createBuffer({
    size: paddedBytes(jobBytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  const resultGPU = device.createBuffer({
    size: paddedBytes(resultBytes),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readGPU = device.createBuffer({
    size: paddedBytes(resultBytes),
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  device.queue.writeBuffer(sampleGPU, 0, buf, sampleOffset, sampleBytes);
  device.queue.writeBuffer(jobGPU, 0, buf, jobOffset, jobBytes);

  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: sampleGPU } },
      { binding: 1, resource: { buffer: jobGPU } },
      { binding: 2, resource: { buffer: resultGPU } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bind);
  pass.dispatchWorkgroups(Math.ceil(jobCount / 64));
  pass.end();
  encoder.copyBufferToBuffer(resultGPU, 0, readGPU, 0, resultBytes);
  device.queue.submit([encoder.finish()]);
  await readGPU.mapAsync(GPUMapMode.READ);
  const copy = readGPU.getMappedRange(0, resultBytes).slice(0);
  readGPU.unmap();
  sampleGPU.destroy();
  jobGPU.destroy();
  resultGPU.destroy();
  readGPU.destroy();
  return unpackFitResults(copy);
}

export { packFitResults };
