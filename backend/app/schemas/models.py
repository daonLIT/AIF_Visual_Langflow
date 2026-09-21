"""요청/응답 스키마 (pydantic v2)."""
from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator
from ..i18n import t

MAX_DOCUMENT_CHARS = 200_000


class AnalysisRunCreate(BaseModel):
    text: str = Field(..., description="판결문 원문. 줄바꿈·공백을 그대로 보존한다.")
    documentId: str = Field(..., min_length=1, max_length=128)
    documentVersion: int = Field(1, ge=1)
    caseId: str | None = Field(None, max_length=128)
    idempotencyKey: str | None = Field(None, max_length=256)
    # 생략하면 파이프라인 탭에서 지정한 분석 flow(없으면 LANGFLOW_FLOW_ID).
    # 쟁점은 사용자가 미리 고르지 않는다: flow 가 52개 카탈로그 중 판결문이 정하는 수만큼(상한 이하) 자동 선택한다.
    flowId: str | None = Field(None, max_length=128)
    purpose: Literal["analysis", "pipeline-test"] = "analysis"

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError(t("schema.document_empty"))
        if len(value) > MAX_DOCUMENT_CHARS:
            raise ValueError(t("schema.document_too_long", max=f"{MAX_DOCUMENT_CHARS:,}"))
        return value


class EvidenceSpan(BaseModel):
    quote: str
    start: int | None = None
    end: int | None = None
    match: Literal["exact", "normalized", "ambiguous", "unmatched", "manual", "stale"]
    documentVersion: int
    candidates: list[dict[str, int]] = Field(default_factory=list)
    derived: bool = False
    # 노드 본문을 고친 뒤 이 근거가 여전히 맞는지 사람이 다시 봐야 할 때의 사유
    reviewReason: str | None = None


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


PROJECT_SCHEMA_VERSION = 2


class ProjectFile(BaseModel):
    # v1 파일도 받아서 v2 로 저장한다(v2: 노드 값에 summary 메타 / schemeApplication / issueRef·issueRefs 가 선택적으로 추가된 형식).
    schemaVersion: Literal[1, 2] = PROJECT_SCHEMA_VERSION
    projectId: str = Field(..., min_length=1, max_length=128)
    revision: int = Field(..., ge=0)
    title: str | None = None
    document: ProjectDocument
    acceptedGraph: dict[str, Any]
    analysisRuns: list[dict[str, Any]] = Field(default_factory=list)
    annotations: list[Annotation] = Field(default_factory=list)
    reviewEvents: list[dict[str, Any]] = Field(default_factory=list)
    analysisSettings: dict[str, Any] | None = None
    # 저장 시점의 쟁점·scheme 카탈로그 버전과 sha256 (API 키 등 비밀 값은 없음)
    catalogs: dict[str, Any] | None = None
    savedAt: str | None = None


class EvidenceVerifyRequest(BaseModel):
    text: str
    spans: list[dict[str, Any]]


class SummaryItem(BaseModel):
    nodeId: str = Field(..., min_length=1, max_length=200)
    type: Literal["I", "ISSUE"] = "I"
    text: str = Field(..., min_length=1, max_length=20_000)


class SummariesRequest(BaseModel):
    items: list[SummaryItem] = Field(..., min_length=1, max_length=40)
    flowId: str | None = Field(None, max_length=128)


# ---- 외부 결과 게시 (Langflow Desktop → 중앙 서버) ----
EXTERNAL_RUN_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$"
MAX_RESULT_NODES = 2_000
MAX_RESULT_EDGES = 4_000


class PublishSource(BaseModel):
    kind: Literal["langflow-desktop"]
    flowId: str | None = Field(None, max_length=128)
    flowName: str | None = Field(None, max_length=256)
    # 게시 컴포넌트가 실제로 알 수 있는 값만. 모르는 값은 비워 둔다(서버가 채워 넣지 않음).
    componentVersion: str | None = Field(None, max_length=64)
    models: list[str] = Field(default_factory=list, max_length=20)


class PublishDocument(BaseModel):
    text: str
    caseId: str | None = Field(None, max_length=128)
    title: str | None = Field(None, max_length=256)

    @field_validator("text")
    @classmethod
    def _text_not_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError(t("schema.document_empty"))
        if len(value) > MAX_DOCUMENT_CHARS:
            raise ValueError(t("schema.document_too_long", max=f"{MAX_DOCUMENT_CHARS:,}"))
        return value


class PublishCatalogs(BaseModel):
    issueCatalogVersion: int | str
    issueCatalogSha256: str = Field(..., min_length=64, max_length=64)
    schemeCatalogVersion: int | str
    schemeCatalogSha256: str = Field(..., min_length=64, max_length=64)


class LangflowResultPublish(BaseModel):
    schemaVersion: Literal[1]
    externalRunId: str = Field(..., pattern=EXTERNAL_RUN_ID_PATTERN)
    source: PublishSource
    document: PublishDocument
    catalogs: PublishCatalogs
    # Result Validator 가 낸 최종 AIF JSON 그대로 ({status, AIF, OVA, meta, errors, reason ...})
    result: dict[str, Any]

    @field_validator("result")
    @classmethod
    def _result_size(cls, value: dict[str, Any]) -> dict[str, Any]:
        aif = value.get("AIF") if isinstance(value.get("AIF"), dict) else {}
        nodes = aif.get("nodes") if isinstance(aif.get("nodes"), list) else []
        edges = aif.get("edges") if isinstance(aif.get("edges"), list) else []
        if len(nodes) > MAX_RESULT_NODES or len(edges) > MAX_RESULT_EDGES:
            raise ValueError(t("schema.result_too_large", nodes=MAX_RESULT_NODES, edges=MAX_RESULT_EDGES))
        return value
