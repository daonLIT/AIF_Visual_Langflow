/**
 * 노드 본문 해시. backend/app/services/texthash.py, langflow/components/node_summarizer.py 와 같은 값을 낸다.
 * 요약이 어떤 본문으로 만들어졌는지(summarySourceHash) 비교하는 용도이며 보안 해시가 아니다.
 */
const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function textHash(text: string): string {
  let value = OFFSET;
  for (const byte of new TextEncoder().encode(text ?? '')) {
    value ^= BigInt(byte);
    value = (value * PRIME) & MASK;
  }
  return `fnv1a64:${value.toString(16).padStart(16, '0')}`;
}
