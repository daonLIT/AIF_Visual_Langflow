"""요청/응답 스키마 (pydantic v2)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

MAX_DOCUMENT_CHARS = 200_000


class AnalysisRunCreate(BaseModel):
    text: str = Field(..., description="판결문 원문. 줄바꿈·공백을 그대로 보존한다.")
    documentId: str = Field(..., min_length=1, max_length=128)
    documentVersion: int = Field(1, ge=1)
    caseId: str | None = Field(None, max_length=128)
    idempotencyKey: str | None = Field(None, max_length=128)

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("판결문 원문이 비어 있습니다.")
        if len(value) > MAX_DOCUMENT_CHARS:
            raise ValueError(f"판결문이 너무 깁니다 (최대 {MAX_DOCUMENT_CHARS:,}자).")
        return value


class EvidenceSpan(BaseModel):
    quote: str
    start: int | None = None
    end: int | None = None
    match: Literal["exact", "normalized", "ambiguous", "unmatched", "manual", "stale"]
    documentVersion: int
    candidates: list[dict[str, int]] = Field(default_factory=list)
    derived: bool = False


class Annotation(BaseModel):
    id: str
    runId: str
    kind: Literal["node", "edge"]
    nodeId: str | None = None
    edgeId: str | None = None
    origin: Literal["ai", "rule", "human"]
    status: Literal["pending", "accepted", "modified", "rejected"]
    originalValue: dict[str, Any]
    currentValue: dict[str, Any]
    evidence: list[EvidenceSpan] = Field(default_factory=list)
    createdAt: str
    updatedAt: str
    acceptedEdgeId: int | None = None
    note: str | None = None


class ProjectDocument(BaseModel):
    id: str
    text: str
    hash: str
    version: int = Field(..., ge=1)
    caseId: str | None = None


class ProjectFile(BaseModel):
    schemaVersion: Literal[1] = 1
    projectId: str = Field(..., min_length=1, max_length=128)
    revision: int = Field(..., ge=0)
    title: str | None = None
    document: ProjectDocument
    acceptedGraph: dict[str, Any]
    analysisRuns: list[dict[str, Any]] = Field(default_factory=list)
    annotations: list[Annotation] = Field(default_factory=list)
    reviewEvents: list[dict[str, Any]] = Field(default_factory=list)
    savedAt: str | None = None


class EvidenceVerifyRequest(BaseModel):
    text: str
    spans: list[dict[str, Any]]
