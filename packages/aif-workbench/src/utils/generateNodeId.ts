/**
 * 기존 JSON 의 노드 ID 는 `{sequence}_{YYYYMMDDHHmmss}` 형태를 따른다.
 * 새 노드도 같은 스타일로 만들되 현재 그래프 안에서 유일함을 보장한다.
 */

function timestamp(date: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

/** 기존 ID 중 `{n}_...` 형태의 최대 시퀀스 번호를 찾는다. */
function maxSequence(existingIds: Iterable<string>): number {
  let max = 0;
  for (const id of existingIds) {
    const match = /^(\d+)_/.exec(id);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return max;
}

export function generateNodeId(existingIds: Iterable<string>, date = new Date()): string {
  const ids = new Set(existingIds);
  let sequence = maxSequence(ids) + 1;
  const stamp = timestamp(date);

  let candidate = `${sequence}_${stamp}`;
  while (ids.has(candidate)) {
    sequence += 1;
    candidate = `${sequence}_${stamp}`;
  }
  return candidate;
}
