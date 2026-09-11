/** 앱 내부에서 사용하는 정규화된 논증 그래프 모델. */

export const NODE_TYPES = ['I', 'RA', 'CA', 'ISSUE'] as const;

export type ArgumentNodeType = (typeof NODE_TYPES)[number];

export interface ArgumentNode {
  id: string;
  type: ArgumentNodeType;
  text: string;
  x: number;
  y: number;
  visible: boolean;
  /** 원본 AIF 노드(알 수 없는 필드 보존용) */
  raw?: Record<string, unknown>;
  /** 원본 OVA 노드(알 수 없는 필드 보존용) */
  rawOva?: Record<string, unknown>;
}

export interface ArgumentEdge {
  id: number;
  source: string;
  target: string;
  visible: boolean;
  raw?: Record<string, unknown>;
  rawOva?: Record<string, unknown>;
}

export interface ArgumentCase {
  fileName?: string;
  text: string;
  nodes: ArgumentNode[];
  edges: ArgumentEdge[];
  /** import 원본 JSON 전체. export 시 base 로 사용한다. */
  rawMetadata?: Record<string, unknown>;
}

export type ValidationLevel = 'error' | 'warning';

export interface ValidationResult {
  level: ValidationLevel;
  code: string;
  nodeId?: string;
  edgeId?: number;
  message: string;
}

export function isArgumentNodeType(value: unknown): value is ArgumentNodeType {
  return typeof value === 'string' && (NODE_TYPES as readonly string[]).includes(value);
}
