/**
 * 프로젝트 JSON(AIF / OVA) 원본 구조 타입.
 * 알 수 없는 필드도 그대로 보존해야 하므로 인덱스 시그니처를 허용한다.
 */

export interface RawAifNode {
  nodeID: string;
  text: string;
  type: string;
  [key: string]: unknown;
}

export interface RawAifEdge {
  edgeID: number | string;
  fromID: string;
  toID: string;
  [key: string]: unknown;
}

export interface RawOvaNode {
  nodeID: string;
  visible?: boolean;
  x?: number;
  y?: number;
  timestamp?: string;
  [key: string]: unknown;
}

export interface RawOvaEdge {
  fromID: string;
  toID: string;
  visible?: boolean;
  [key: string]: unknown;
}

export interface RawAifSection {
  nodes?: RawAifNode[];
  edges?: RawAifEdge[];
  schemefulfillments?: unknown[];
  participants?: unknown[];
  locutions?: unknown[];
  descriptorfulfillments?: unknown[];
  cqdescriptorfulfillments?: unknown[];
  [key: string]: unknown;
}

export interface RawOvaSection {
  firstname?: string;
  surname?: string;
  url?: string;
  nodes?: RawOvaNode[];
  edges?: RawOvaEdge[];
  [key: string]: unknown;
}

export interface RawCaseJson {
  AIF?: RawAifSection;
  text?: string;
  OVA?: RawOvaSection;
  [key: string]: unknown;
}
