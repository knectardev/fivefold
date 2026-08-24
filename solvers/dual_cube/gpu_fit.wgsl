struct Job {
  family: u32,
  aStart: u32,
  aCount: u32,
  bStart: u32,
  bCount: u32,
  loopStart: u32,
  loopCount: u32,
  pad: u32,
  p0: vec4<f32>,
  p1: vec4<f32>,
  p2: vec4<f32>,
};

struct Result {
  fitRms: f32,
  fitMax: f32,
  mateARms: f32,
  mateAMax: f32,
  mateBRms: f32,
  mateBMax: f32,
  boundaryRms: f32,
  penalty: f32,
  score: f32,
  degeneracy: u32,
  pad0: u32,
  pad1: u32,
};

@group(0) @binding(0) var<storage, read> samples: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read> jobs: array<Job>;
@group(0) @binding(2) var<storage, read_write> results: array<Result>;

fn is_finite(x: f32) -> bool {
  return x == x && abs(x) < 1e20;
}

fn eval_sphere(p: vec3<f32>, c: vec3<f32>, r: f32) -> f32 {
  return length(p - c) - r;
}

fn eval_cylinder(p: vec3<f32>, axis: vec3<f32>, point: vec3<f32>, r: f32) -> f32 {
  let a = normalize(axis);
  let w = p - point;
  return length(w - a * dot(w, a)) - r;
}

fn eval_cone(p: vec3<f32>, apex: vec3<f32>, axis: vec3<f32>, angle: f32) -> f32 {
  let a = normalize(axis);
  let w = p - apex;
  let h = dot(w, a);
  let radial = length(w - a * h);
  return radial - abs(h) * tan(angle);
}

fn eval_quadric(p: vec3<f32>, c0: vec4<f32>, c1: vec4<f32>, c2: vec4<f32>) -> f32 {
  let x = p.x;
  let y = p.y;
  let z = p.z;
  let a = c0.x;
  let b = c0.y;
  let c = c0.z;
  let d = c0.w;
  let e = c1.x;
  let f = c1.y;
  let g = c1.z;
  let h = c1.w;
  let i = c2.x;
  let j = c2.y;
  let val = a * x * x + b * y * y + c * z * z + d * x * y + e * y * z + f * z * x + g * x + h * y + i * z + j;
  let gx = 2.0 * a * x + d * y + f * z + g;
  let gy = 2.0 * b * y + d * x + e * z + h;
  let gz = 2.0 * c * z + e * y + f * x + i;
  let gn = max(length(vec3<f32>(gx, gy, gz)), 1.0);
  return val / gn;
}

fn eval_family(family: u32, p: vec3<f32>, job: Job) -> f32 {
  if (family == 0u) {
    return eval_sphere(p, job.p0.xyz, job.p0.w);
  }
  if (family == 1u) {
    return eval_cylinder(p, job.p0.xyz, job.p1.xyz, job.p1.w);
  }
  if (family == 2u) {
    return eval_cone(p, job.p0.xyz, job.p1.xyz, job.p1.w);
  }
  return eval_quadric(p, job.p0, job.p1, job.p2);
}

fn stats(job: Job, start: u32, count: u32) -> vec3<f32> {
  // returns rms, max, degen-as-float
  var sum = 0.0;
  var mx = 0.0;
  var degen = 0.0;
  if (count == 0u) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  for (var i = 0u; i < count; i = i + 1u) {
    let p = samples[start + i].xyz;
    let v = eval_family(job.family, p, job);
    if (!is_finite(v)) {
      degen = 1.0;
      continue;
    }
    let av = abs(v);
    sum = sum + av * av;
    mx = max(mx, av);
  }
  return vec3<f32>(sqrt(sum / f32(count)), mx, degen);
}

fn degeneracy_params(job: Job) -> u32 {
  var flags = 0u;
  if (job.family == 0u || job.family == 1u) {
    let r = select(job.p0.w, job.p1.w, job.family == 1u);
    if (!(r > 1e-8) || !is_finite(r)) {
      flags = flags | 2u;
    }
  }
  if (job.family == 1u || job.family == 2u) {
    let axis = select(job.p0.xyz, job.p1.xyz, job.family == 2u);
    if (length(axis) < 1e-8) {
      flags = flags | 4u;
    }
  }
  if (job.aCount == 0u) {
    flags = flags | 8u;
  }
  return flags;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= arrayLength(&jobs)) {
    return;
  }
  let job = jobs[i];
  var flags = degeneracy_params(job);
  let a = stats(job, job.aStart, job.aCount);
  let b = stats(job, job.bStart, job.bCount);
  let loop = stats(job, job.loopStart, job.loopCount);
  if (a.z > 0.5 || b.z > 0.5 || loop.z > 0.5) {
    flags = flags | 1u;
  }
  var penalty = 0.0;
  if (job.family == 1u) { penalty = 0.12; }
  if (job.family == 2u) { penalty = 0.24; }
  if (job.family == 3u) { penalty = 0.60; }
  var score = a.x * (1.0 + penalty) + 0.35 * (a.x + b.x) + 0.15 * loop.x;
  if (flags != 0u) {
    score = 1e30;
  }
  results[i].fitRms = a.x;
  results[i].fitMax = a.y;
  results[i].mateARms = a.x;
  results[i].mateAMax = a.y;
  results[i].mateBRms = b.x;
  results[i].mateBMax = b.y;
  results[i].boundaryRms = loop.x;
  results[i].penalty = penalty;
  results[i].score = score;
  results[i].degeneracy = flags;
  results[i].pad0 = 0u;
  results[i].pad1 = 0u;
}
