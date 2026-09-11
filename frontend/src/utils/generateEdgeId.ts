/** 새 엣지 ID 는 `max(existing) + 1`. 삭제된 ID 는 같은 세션에서 재사용하지 않는다. */
export function generateEdgeId(existingIds: Iterable<number>): number {
  let max = 0;
  for (const id of existingIds) {
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max + 1;
}
