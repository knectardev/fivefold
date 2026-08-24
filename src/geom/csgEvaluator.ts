import { Evaluator } from 'three-bvh-csg';

/** Shared evaluator configured for meshes without UVs. */
export function createEvaluator(): Evaluator {
  const evaluator = new Evaluator();
  evaluator.attributes = ['position', 'normal'];
  evaluator.useGroups = false;
  return evaluator;
}
