"""사용자에게 보이는 메시지의 한국어/영어.

- 언어는 요청의 `Accept-Language` 로 정해지고 contextvar 로 흐른다(분석 실행 task 도 요청 컨텍스트를 물려받는다).
- 로그·마이그레이션 설명처럼 운영자만 보는 문구는 번역하지 않는다.
- `t(key, **params)` 는 그 자리에서 문자열을 만들고, `Msg(key, **params)` 는 str() 할 때 만든다
  (서버 시작 시 생긴 카탈로그 오류처럼, 만들 때는 언어를 모르고 응답할 때 정해지는 경우에 쓴다).
- 메시지 표는 ko/en 을 항상 함께 둔다. 없는 키는 키 자체를 돌려주므로 화면에서 바로 눈에 띈다.
"""
from __future__ import annotations

from contextvars import ContextVar

LANGUAGES = ("ko", "en")
DEFAULT_LANGUAGE = "ko"

_current_language: ContextVar[str] = ContextVar("annotation_language", default=DEFAULT_LANGUAGE)


def current_language() -> str:
    return _current_language.get()


def set_language(language: str):
    """현재 컨텍스트의 언어를 바꾸고 되돌릴 token 을 준다."""
    return _current_language.set(language if language in LANGUAGES else DEFAULT_LANGUAGE)


def reset_language(token) -> None:
    _current_language.reset(token)


def parse_accept_language(header: str | None) -> str:
    """Accept-Language 에서 지원하는 언어를 고른다. 모르면 기본값(한국어)."""
    if not header:
        return DEFAULT_LANGUAGE
    best: tuple[float, str] | None = None
    for part in header.split(","):
        piece = part.strip()
        if not piece:
            continue
        tag, _, params = piece.partition(";")
        quality = 1.0
        if params.strip().startswith("q="):
            try:
                quality = float(params.strip()[2:])
            except ValueError:
                quality = 0.0
        primary = tag.strip().lower().split("-")[0]
        if primary not in LANGUAGES:
            continue
        if best is None or quality > best[0]:
            best = (quality, primary)
    return best[1] if best and best[0] > 0 else DEFAULT_LANGUAGE


def t(message_key: str, /, **params) -> str:
    """지금 언어로 메시지를 만든다. 자리표시자 이름과 겹치지 않게 키는 위치 인자로만 받는다."""
    table = MESSAGES.get(message_key)
    if table is None:
        return message_key
    text = table.get(current_language()) or table[DEFAULT_LANGUAGE]
    if not params:
        return text
    try:
        return text.format(**params)
    except (KeyError, IndexError, ValueError):
        # 자리표시자가 맞지 않아도 서버를 멈추지 않는다.
        return text


class Msg:
    """str() 하는 시점의 언어로 만들어지는 메시지. 예외 메시지에 그대로 넣을 수 있다."""

    __slots__ = ("key", "params")

    def __init__(self, message_key: str, /, **params):
        self.key = message_key
        self.params = params

    def __str__(self) -> str:
        return t(self.key, **self.params)

    def __repr__(self) -> str:  # 로그·디버깅용
        return f"Msg({self.key!r})"


class Joined:
    """여러 Msg 를 str() 하는 시점에 이어 붙인다 (문제 목록을 한 메시지에 담을 때)."""

    __slots__ = ("items", "separator")

    def __init__(self, items, separator: str = "; "):
        self.items = list(items)
        self.separator = separator

    def __str__(self) -> str:
        return self.separator.join(str(item) for item in self.items)

    def __len__(self) -> int:
        return len(self.items)


MESSAGES: dict[str, dict[str, str]] = {
    # ---- routes / run manager / summaries / schemas ----
    'api.validation': {
        'ko': '요청 본문이 올바르지 않습니다.',
        'en': 'The request body is not valid.',
    },
    'api.bad_json': {
        'ko': 'JSON 본문을 해석할 수 없습니다.',
        'en': 'The JSON body could not be parsed.',
    },
    'api.no_issue_catalog': {
        'ko': '쟁점 카탈로그를 불러오지 못했습니다.',
        'en': 'The issue catalogue could not be loaded.',
    },
    'api.no_scheme_catalog': {
        'ko': '스킴 카탈로그를 불러오지 못했습니다.',
        'en': 'The scheme catalogue could not be loaded.',
    },
    'api.no_catalogs_for_run': {
        'ko': '쟁점·scheme 카탈로그를 불러오지 못해 분석할 수 없습니다.',
        'en': 'The issue and scheme catalogues could not be loaded, so the analysis cannot run.',
    },
    'api.run_not_found': {
        'ko': '실행을 찾을 수 없습니다.',
        'en': 'The run was not found.',
    },
    'api.project_not_found': {
        'ko': '프로젝트를 찾을 수 없습니다.',
        'en': 'The project was not found.',
    },
    'api.project_id_mismatch': {
        'ko': '경로의 projectId 와 본문의 projectId 가 다릅니다.',
        'en': 'The projectId in the path differs from the one in the body.',
    },
    'api.hash_mismatch': {
        'ko': 'document.hash 가 원문과 일치하지 않습니다.',
        'en': 'document.hash does not match the text.',
    },
    'api.revision_conflict': {
        'ko': '프로젝트가 다른 곳에서 수정되었습니다 (서버 revision {server}, 요청 revision {requested}).',
        'en': 'The project was changed elsewhere (server revision {server}, request revision {requested}).',
    },
    'api.evidence_needs_quote': {
        'ko': 'quote 또는 start/end 가 필요합니다.',
        'en': 'A quote or a start/end pair is required.',
    },
    'api.draft_not_found': {
        'ko': '저장된 초안이 없습니다.',
        'en': 'There is no saved draft.',
    },
    'run.interrupted': {
        'ko': '서버가 재시작되어 실행이 중단되었습니다. 다시 분석하세요.',
        'en': 'The server restarted and the run was interrupted. Run the analysis again.',
    },
    'run.cancelled': {
        'ko': '사용자가 취소했습니다. Langflow/Ollama 계산은 계속 진행 중일 수 있습니다.',
        'en': 'Cancelled by the user. Langflow and Ollama may still be computing.',
    },
    'run.timeout': {
        'ko': '서버 실행 제한 시간({seconds}s)을 초과했습니다.',
        'en': 'The server run time limit ({seconds}s) was exceeded.',
    },
    'run.unexpected': {
        'ko': '예상하지 못한 오류: {name}',
        'en': 'Unexpected error: {name}',
    },
    'summaries.unsupported_in_mock': {
        'ko': 'mock 모드에서는 실제 요약을 만들 수 없습니다. live 모드에서 사용하세요.',
        'en': 'Summaries cannot be generated in mock mode. Switch to live mode.',
    },
    'summaries.too_many': {
        'ko': '한 번에 {max}개까지 요약할 수 있습니다.',
        'en': 'At most {max} summaries can be generated at once.',
    },
    'summaries.bad_prompt': {
        'ko': 'Summarizer 프롬프트에 {{nodes_json}} 변수가 없습니다.',
        'en': 'The Summarizer prompt has no {{nodes_json}} variable.',
    },
    'summaries.ollama_unreachable': {
        'ko': 'Ollama 에 연결할 수 없습니다: {name}',
        'en': 'Cannot reach Ollama: {name}',
    },
    'summaries.ollama_error': {
        'ko': 'Ollama 오류 {status}: {body}',
        'en': 'Ollama error {status}: {body}',
    },
    'summaries.bad_answer': {
        'ko': '모델 응답이 JSON 이 아닙니다: {error}',
        'en': 'The model answer is not JSON: {error}',
    },
    'schema.document_empty': {
        'ko': '판결문 원문이 비어 있습니다.',
        'en': 'The judgment text is empty.',
    },
    'schema.document_too_long': {
        'ko': '판결문이 너무 깁니다 (최대 {max}자).',
        'en': 'The judgment is too long (at most {max} characters).',
    },
    'schema.document_field': {
        'ko': '판결문 원문. 줄바꿈·공백을 그대로 보존한다.',
        'en': 'The judgment text. Line breaks and spacing are preserved.',
    },
    'config.bad_mode': {
        'ko': 'LANGFLOW_MODE 값이 올바르지 않습니다: {value} (허용: {allowed})',
        'en': 'LANGFLOW_MODE is not valid: {value} (allowed: {allowed})',
    },
    # ---- catalogs ----
    'catalog.issue': {
        'ko': '쟁점 카탈로그',
        'en': 'issue catalogue',
    },
    'catalog.scheme': {
        'ko': '스킴 카탈로그',
        'en': 'scheme catalogue',
    },
    'catalog.migrations': {
        'ko': '스킴 카탈로그 대응표',
        'en': 'scheme catalogue migration table',
    },
    'catalog.file_missing': {
        'ko': '{label} 파일이 없습니다: {path}',
        'en': 'The {label} file is missing: {path}',
    },
    'catalog.bad_json': {
        'ko': '{label} JSON 을 해석할 수 없습니다: {error}',
        'en': 'The {label} JSON could not be parsed: {error}',
    },
    'catalog.not_object': {
        'ko': '{label} 최상위가 객체가 아닙니다.',
        'en': 'The top level of the {label} is not an object.',
    },
    'catalog.no_issues': {
        'ko': '쟁점 카탈로그에 issues 가 없습니다.',
        'en': 'The issue catalogue has no issues.',
    },
    'catalog.no_issue_id': {
        'ko': '쟁점 카탈로그 항목에 issueId 가 없습니다.',
        'en': 'An issue catalogue entry has no issueId.',
    },
    'catalog.no_schemes': {
        'ko': '스킴 카탈로그에 schemes 가 없습니다.',
        'en': 'The scheme catalogue has no schemes.',
    },
    'catalog.bad_scheme_key': {
        'ko': '스킴 카탈로그의 schemeKey 가 비었거나 예약어입니다: {key}',
        'en': 'A schemeKey in the scheme catalogue is empty or reserved: {key}',
    },
    'catalog.migrations_not_array': {
        'ko': '스킴 카탈로그 대응표의 migrations 가 배열이 아닙니다.',
        'en': 'migrations in the scheme catalogue migration table is not an array.',
    },
    'catalog.migration_no_schemes': {
        'ko': '대응표 항목에 schemes 가 없습니다.',
        'en': 'A migration entry has no schemes.',
    },
    'catalog.migration_bad_version': {
        'ko': '대응표 버전이 올바르지 않습니다: {source} → {target}',
        'en': 'The migration versions are not valid: {source} → {target}',
    },
    'catalog.migration_bad_action': {
        'ko': '{label}: action 이 올바르지 않습니다 ({action})',
        'en': '{label}: the action is not valid ({action})',
    },
    'catalog.migration_keep_missing': {
        'ko': '{label}: keep 인데 현재 카탈로그에 key 가 없습니다',
        'en': '{label}: action is keep but the key is not in the current catalogue',
    },
    'catalog.migration_should_keep': {
        'ko': '{label}: 현재 카탈로그에 있는 key 는 keep 이어야 합니다',
        'en': '{label}: a key that exists in the current catalogue must use keep',
    },
    'catalog.migration_missing_target': {
        'ko': '{label}: 바꿀 key {destination} 가 현재 카탈로그에 없습니다',
        'en': '{label}: the replacement key {destination} is not in the current catalogue',
    },
    'catalog.migration_unknown_roles': {
        'ko': '{label}: {destination} 에 없는 역할 {roles}',
        'en': '{label}: roles not in {destination}: {roles}',
    },
    'catalog.migration_unknown_questions': {
        'ko': '{label}: {destination} 에 없는 CQ {questions}',
        'en': '{label}: CQs not in {destination}: {questions}',
    },
    'catalog.migration_unknown_candidate': {
        'ko': '{label}: 후보 {candidate} 가 현재 카탈로그에 없습니다',
        'en': '{label}: the candidate {candidate} is not in the current catalogue',
    },
    'catalog.migration_errors': {
        'ko': '스킴 카탈로그 대응표 오류: {problems}',
        'en': 'Scheme catalogue migration table errors: {problems}',
    },
    # ---- langflow client / flow repository ----
    'lf.envelope_not_object': {
        'ko': 'Langflow 응답이 JSON 객체가 아닙니다.',
        'en': 'The Langflow response is not a JSON object.',
    },
    'lf.envelope_no_outputs': {
        'ko': 'Langflow 응답에 outputs 배열이 없습니다.',
        'en': 'The Langflow response has no outputs array.',
    },
    'lf.no_message_text': {
        'ko': '출력 컴포넌트 {component} 의 응답에서 Message 텍스트를 찾지 못했습니다.',
        'en': 'No Message text was found in the response of output component {component}.',
    },
    'lf.component_missing': {
        'ko': '출력 컴포넌트 {component} 가 응답에 없습니다. 응답에 포함된 컴포넌트: {seen}',
        'en': 'Output component {component} is not in the response. Components in the response: {seen}',
    },
    'lf.none': {
        'ko': '없음',
        'en': 'none',
    },
    'lf.auth_failed': {
        'ko': 'Langflow 인증에 실패했습니다. API 키 설정을 확인하세요.',
        'en': 'Langflow authentication failed. Check the API key setting.',
    },
    'lf.http_error': {
        'ko': 'Langflow 오류 {status}: {detail}',
        'en': 'Langflow error {status}: {detail}',
    },
    'lf.not_configured': {
        'ko': 'LANGFLOW_FLOW_ID 가 설정되지 않았습니다.',
        'en': 'LANGFLOW_FLOW_ID is not set.',
    },
    'lf.timeout': {
        'ko': 'Langflow 응답 대기 시간({seconds}s)을 초과했습니다.',
        'en': 'Langflow did not answer within the time limit ({seconds}s).',
    },
    'lf.connection': {
        'ko': 'Langflow 서버에 연결할 수 없습니다: {name}',
        'en': 'Cannot reach the Langflow server: {name}',
    },
    'lf.flow_not_found_by_id': {
        'ko': 'Flow ID 에 해당하는 flow 를 찾을 수 없습니다.',
        'en': 'No flow matches the Flow ID.',
    },
    'lf.response_not_json': {
        'ko': 'Langflow 응답이 JSON 이 아닙니다.',
        'en': 'The Langflow response is not JSON.',
    },
    'lf.response_not_json_path': {
        'ko': 'Langflow 응답이 JSON 이 아닙니다 ({path}).',
        'en': 'The Langflow response is not JSON ({path}).',
    },
    'lf.mock_fixture_missing': {
        'ko': 'mock fixture 가 없습니다: {name}',
        'en': 'The mock fixture is missing: {name}',
    },
    'lf.flow_not_found': {
        'ko': 'flow 를 찾을 수 없습니다.',
        'en': 'The flow was not found.',
    },
    'lf.flow_no_data': {
        'ko': 'Langflow 가 돌려준 flow 에 data 가 없습니다.',
        'en': 'The flow returned by Langflow has no data.',
    },
    'lf.no_component_template': {
        'ko': 'Langflow 가 컴포넌트 template 을 돌려주지 않았습니다.',
        'en': 'Langflow did not return a component template.',
    },
    'lf.rebuild_unsupported_in_mock': {
        'ko': 'mock 모드에서는 코드로 컴포넌트 입력·출력을 다시 만들 수 없습니다. 코드 텍스트는 저장되지만 필드 구성은 그대로입니다.',
        'en': 'Inputs and outputs cannot be rebuilt from code in mock mode. The code text is saved but the fields stay as they are.',
    },
    'lf.code_check_unsupported_in_mock': {
        'ko': 'mock 모드에서는 Langflow 코드 검사를 사용할 수 없습니다.',
        'en': 'The Langflow code check is not available in mock mode.',
    },
    # ---- aif adapter (analysis result) ----
    'adapter.not_string': {
        'ko': '결과가 문자열이 아닙니다.',
        'en': 'The result is not a string.',
    },
    'adapter.json_parse_failed': {
        'ko': '결과 JSON 파싱 실패: {message} (line {line})',
        'en': 'The result JSON could not be parsed: {message} (line {line})',
    },
    'adapter.json_not_object': {
        'ko': '결과 JSON 의 최상위가 객체가 아닙니다.',
        'en': 'The top level of the result JSON is not an object.',
    },
    'adapter.no_aif': {
        'ko': 'AIF 섹션이 없습니다.',
        'en': 'There is no AIF section.',
    },
    'adapter.nodes_empty': {
        'ko': 'AIF.nodes 가 비어 있거나 배열이 아닙니다.',
        'en': 'AIF.nodes is empty or not an array.',
    },
    'adapter.edges_not_array': {
        'ko': 'AIF.edges 가 배열이 아닙니다.',
        'en': 'AIF.edges is not an array.',
    },
    'adapter.node_not_object': {
        'ko': 'nodes[{index}] 가 객체가 아닙니다.',
        'en': 'nodes[{index}] is not an object.',
    },
    'adapter.node_no_id': {
        'ko': 'nodes[{index}] 에 nodeID 가 없습니다.',
        'en': 'nodes[{index}] has no nodeID.',
    },
    'adapter.duplicate_node_id': {
        'ko': '중복 nodeID: {nodeId}',
        'en': 'Duplicate nodeID: {nodeId}',
    },
    'adapter.bad_node_type': {
        'ko': '노드 {nodeId} 의 type 이 허용값이 아닙니다: {type}',
        'en': 'The type of node {nodeId} is not allowed: {type}',
    },
    'adapter.text_not_string': {
        'ko': '노드 {nodeId} 의 text 가 문자열이 아닙니다.',
        'en': 'The text of node {nodeId} is not a string.',
    },
    'adapter.text_empty': {
        'ko': '노드 {nodeId} 의 text 가 비어 있습니다.',
        'en': 'The text of node {nodeId} is empty.',
    },
    'adapter.evidence_not_array': {
        'ko': '노드 {nodeId} 의 evidence 가 배열이 아닙니다.',
        'en': 'The evidence of node {nodeId} is not an array.',
    },
    'adapter.summary_not_string': {
        'ko': '노드 {nodeId} 의 summary 가 문자열이 아닙니다.',
        'en': 'The summary of node {nodeId} is not a string.',
    },
    'adapter.field_not_object': {
        'ko': '노드 {nodeId} 의 {field} 가 객체가 아닙니다.',
        'en': 'The {field} of node {nodeId} is not an object.',
    },
    'adapter.issue_refs_not_array': {
        'ko': '노드 {nodeId} 의 issueRefs 가 배열이 아닙니다.',
        'en': 'The issueRefs of node {nodeId} is not an array.',
    },
    'adapter.edge_not_object': {
        'ko': 'edges[{index}] 가 객체가 아닙니다.',
        'en': 'edges[{index}] is not an object.',
    },
    'adapter.edge_id_not_int': {
        'ko': 'edges[{index}] 의 edgeID 가 정수가 아닙니다.',
        'en': 'The edgeID of edges[{index}] is not an integer.',
    },
    'adapter.duplicate_edge_id': {
        'ko': '중복 edgeID: {edgeId}',
        'en': 'Duplicate edgeID: {edgeId}',
    },
    'adapter.edge_bad_ref': {
        'ko': 'edges[{index}] 의 {field}({ref}) 에 해당하는 노드가 없습니다.',
        'en': 'edges[{index}] refers to {field}({ref}), which is not a node.',
    },
    'adapter.edge_self': {
        'ko': 'edges[{index}] 가 자기 자신을 가리킵니다.',
        'en': 'edges[{index}] points to its own node.',
    },
    'adapter.ova_not_object': {
        'ko': 'OVA 섹션이 객체가 아닙니다.',
        'en': 'The OVA section is not an object.',
    },
    'adapter.ova_node_bad_ref': {
        'ko': 'OVA.nodes[{index}] 가 존재하지 않는 AIF 노드를 참조합니다.',
        'en': 'OVA.nodes[{index}] refers to an AIF node that does not exist.',
    },
    'adapter.ova_edge_bad_ref': {
        'ko': 'OVA.edges[{index}] 가 존재하지 않는 AIF 노드를 참조합니다.',
        'en': 'OVA.edges[{index}] refers to an AIF node that does not exist.',
    },
    'adapter.scheme_key_not_allowed': {
        'ko': "허용되지 않은 scheme key '{key}'",
        'en': "Scheme key '{key}' is not allowed",
    },
    'adapter.scheme_key_unclassified': {
        'ko': "RA {nodeId}: 허용되지 않은 scheme '{key}' 를 미분류로 두었습니다.",
        'en': "RA {nodeId}: scheme '{key}' is not allowed, so it was left unclassified.",
    },
    'adapter.role_not_in_scheme': {
        'ko': "scheme {key} 에 없는 전제 역할 '{role}'",
        'en': "Premise role '{role}' is not part of scheme {key}",
    },
    'adapter.premise_ref_bad': {
        'ko': '전제 참조 {ref} 가 이 RA 로 들어오는 노드가 아닙니다',
        'en': 'The premise reference {ref} is not a node coming into this RA',
    },
    'adapter.conclusion_ref_bad': {
        'ko': '결론 참조 {ref} 가 이 RA 가 가리키는 노드가 아닙니다',
        'en': 'The conclusion reference {ref} is not a node this RA points to',
    },
    'adapter.question_not_in_scheme': {
        'ko': 'scheme {key} 에 없는 비판적 질문 {questionId}',
        'en': 'Critical question {questionId} is not part of scheme {key}',
    },
    'adapter.fulfillment_dropped': {
        'ko': 'AIF.{field} 항목이 없는 노드 {nodeId} 를 가리켜 제외했습니다.',
        'en': 'An AIF.{field} entry pointed at missing node {nodeId} and was left out.',
    },
    'adapter.invalid_selection': {
        'ko': 'Langflow 결과가 검증을 통과하지 못했습니다(쟁점 선택 또는 그래프 제약 위반).',
        'en': 'The Langflow result did not pass validation (issue selection or graph constraints).',
    },
    'adapter.unknown_status': {
        'ko': '알 수 없는 결과 status: {status}',
        'en': 'Unknown result status: {status}',
    },
    'adapter.graph_invalid': {
        'ko': 'Langflow 결과 그래프가 유효하지 않습니다.',
        'en': 'The graph in the Langflow result is not valid.',
    },
    'adapter.too_many_issues': {
        'ko': '쟁점 노드가 {count}개입니다(최대 {max}개).',
        'en': 'There are {count} issue nodes (at most {max}).',
    },
    'adapter.issue_not_in_catalog': {
        'ko': "쟁점 노드 {nodeId} 의 issueId '{issueId}' 는 카탈로그에 없습니다.",
        'en': "The issueId '{issueId}' of issue node {nodeId} is not in the catalogue.",
    },
    'adapter.issue_duplicated': {
        'ko': "issueId '{issueId}' 가 중복 선택되었습니다.",
        'en': "The issueId '{issueId}' was selected more than once.",
    },
    'adapter.selection_constraints': {
        'ko': '쟁점 선택 제약(최대 {max}개·카탈로그 ID·중복 없음)을 어겼습니다.',
        'en': 'The issue selection broke the constraints (at most {max}, catalogue IDs, no duplicates).',
    },
    'adapter.missing_positions': {
        'ko': 'OVA 좌표가 없는 노드 {count}개는 기본 좌표(0,0)를 사용합니다.',
        'en': '{count} nodes have no OVA position and use the default (0,0).',
    },
    'adapter.issue_not_grounded': {
        'ko': '선택 쟁점 {issueId}: 원문에서 근거를 찾지 못했습니다(근거 없음/미검출).',
        'en': 'Selected issue {issueId}: no supporting text was found.',
    },
    'adapter.selection_warning': {
        'ko': '쟁점 선택: {item}',
        'en': 'Issue selection: {item}',
    },
    'adapter.branch_failed': {
        'ko': '쟁점 {label} 세부 추출 {status}: {error}',
        'en': 'Issue {label} branch extraction {status}: {error}',
    },
    'adapter.branch_unknown_error': {
        'ko': '원인 미상',
        'en': 'cause unknown',
    },
    'adapter.branch_warning': {
        'ko': '쟁점 {label}: {item}',
        'en': 'Issue {label}: {item}',
    },
    'adapter.summaries_missing': {
        'ko': '요약을 만들지 못한 노드 {count}개 (본문 앞부분을 임시 표시)',
        'en': '{count} nodes have no summary (the start of the text is shown instead)',
    },
    'adapter.scheme_warning': {
        'ko': 'scheme 분류: {item}',
        'en': 'Scheme classification: {item}',
    },
    'adapter.flow_validation': {
        'ko': 'flow 검증: {item}',
        'en': 'Flow validation: {item}',
    },
    # ---- pipeline flow model ----
    'flow.kind.input': {
        'ko': '입력',
        'en': 'Input',
    },
    'flow.kind.prompt': {
        'ko': '프롬프트',
        'en': 'Prompt',
    },
    'flow.kind.llm': {
        'ko': '언어 모델',
        'en': 'Language model',
    },
    'flow.kind.custom': {
        'ko': '커스텀 컴포넌트',
        'en': 'Custom component',
    },
    'flow.kind.output': {
        'ko': '출력',
        'en': 'Output',
    },
    'flow.kind.generic': {
        'ko': '기타 컴포넌트',
        'en': 'Other component',
    },
    'flow.support.generic': {
        'ko': '편집기가 전용 속성 화면을 제공하지 않는 컴포넌트입니다. 위치·연결·기본 필드만 편집하고 나머지 필드는 그대로 보존합니다.',
        'en': 'The editor has no dedicated property screen for this component. You can edit its position, connections and basic fields; the rest are kept as they are.',
    },
    'flow.support.input': {
        'ko': '입력 컴포넌트. 중계 서버가 실행 시 value 를 tweaks 로 덮어씁니다.',
        'en': 'Input component. The relay server overrides its value with tweaks at run time.',
    },
    'flow.support.prompt': {
        'ko': '프롬프트 텍스트를 편집하면 {{변수}} 에 맞춰 입력 필드가 추가·삭제됩니다.',
        'en': 'Editing the prompt text adds and removes input fields to match the {{variables}}.',
    },
    'flow.support.llm': {
        'ko': '모델·온도·timeout·컨텍스트 등 모델 설정을 편집할 수 있습니다.',
        'en': 'You can edit model settings such as the model, temperature, timeout and context size.',
    },
    'flow.support.custom': {
        'ko': '필드 값과(고급) 실행 코드를 편집할 수 있습니다. 코드 변경은 실행되는 변경입니다.',
        'en': 'You can edit the field values and (advanced) the code that runs. A code change is a change to what executes.',
    },
    'flow.support.output': {
        'ko': '최종 출력 컴포넌트. 중계 서버는 이 컴포넌트의 Message 만 사용합니다.',
        'en': "Final output component. The relay server uses only this component's Message.",
    },
    'flow.secret_missing': {
        'ko': '{node}.{field}: 원격에 없는 비밀 값이라 비워 두었습니다.',
        'en': '{node}.{field}: the secret does not exist remotely, so it was left empty.',
    },
    'flow.prompt.brace_mismatch': {
        'ko': '중괄호가 맞지 않습니다 ({error}). 문자 그대로의 중괄호는 {{{{ }}}} 로 두 번 쓰세요.',
        'en': 'The braces do not match ({error}). For a literal brace, write it twice: {{{{ }}}}.',
    },
    'flow.prompt.empty_variable': {
        'ko': '빈 변수 {{}} 가 있습니다.',
        'en': 'There is an empty variable: {{}}.',
    },
    'flow.prompt.bad_name': {
        'ko': '변수 이름으로 쓸 수 없는 형식입니다: {{{name}}}. JSON 예시의 중괄호는 {{{{ }}}} 로 두 번 쓰세요.',
        'en': 'This cannot be used as a variable name: {{{name}}}. In a JSON example, write braces twice: {{{{ }}}}.',
    },
    'flow.prompt.reserved': {
        'ko': '예약된 이름은 변수로 쓸 수 없습니다: {name}',
        'en': 'This name is reserved and cannot be a variable: {name}',
    },
    'flow.data_not_object': {
        'ko': 'flow data 가 객체가 아닙니다.',
        'en': 'The flow data is not an object.',
    },
    'flow.data_missing_arrays': {
        'ko': 'flow data 에 nodes / edges 배열이 필요합니다.',
        'en': 'The flow data needs nodes and edges arrays.',
    },
    'flow.node_no_id': {
        'ko': 'nodes[{index}] 에 id 가 없습니다.',
        'en': 'nodes[{index}] has no id.',
    },
    'flow.duplicate_node': {
        'ko': '중복 노드 id: {nodeId}',
        'en': 'Duplicate node id: {nodeId}',
    },
    'flow.node_data_id': {
        'ko': '{nodeId}: data.id 가 노드 id 와 다릅니다.',
        'en': '{nodeId}: data.id differs from the node id.',
    },
    'flow.no_template': {
        'ko': '{nodeId}: 컴포넌트 template 이 없습니다.',
        'en': '{nodeId}: the component has no template.',
    },
    'flow.unsupported_component': {
        'ko': '{name}: 전용 속성 편집을 지원하지 않는 컴포넌트입니다(필드 보존).',
        'en': '{name}: this component has no dedicated property editor (its fields are preserved).',
    },
    'flow.prompt_field_missing': {
        'ko': '{nodeId}: 프롬프트 변수 {{{name}}} 의 입력 필드가 없습니다.',
        'en': '{nodeId}: there is no input field for the prompt variable {{{name}}}.',
    },
    'flow.prompt_custom_fields': {
        'ko': '{nodeId}: custom_fields 에 {name} 이 없습니다.',
        'en': '{nodeId}: {name} is not in custom_fields.',
    },
    'flow.prompt_field_unused': {
        'ko': '{nodeId}: 프롬프트에서 쓰지 않는 변수 필드 {name} 가 남아 있습니다.',
        'en': '{nodeId}: the variable field {name} is left over and is not used by the prompt.',
    },
    'flow.edge_not_object': {
        'ko': 'edges[{index}] 가 객체가 아닙니다.',
        'en': 'edges[{index}] is not an object.',
    },
    'flow.edge_endpoint': {
        'ko': '연결 {edgeId}: 없는 노드를 가리킵니다.',
        'en': 'Connection {edgeId}: it points at a node that does not exist.',
    },
    'flow.edge_handle': {
        'ko': '연결 {edgeId}: handle 을 해석할 수 없습니다.',
        'en': 'Connection {edgeId}: the handle could not be parsed.',
    },
    'flow.edge_handle_mismatch': {
        'ko': '연결 {edgeId}: handle 문자열과 data 가 다릅니다.',
        'en': 'Connection {edgeId}: the handle string differs from the data.',
    },
    'flow.edge_handle_id': {
        'ko': '연결 {edgeId}: handle 의 id 가 노드와 다릅니다.',
        'en': 'Connection {edgeId}: the id in the handle differs from the node.',
    },
    'flow.edge_output': {
        'ko': '연결 {edgeId}: {nodeId} 에 출력 {name} 이 없습니다.',
        'en': 'Connection {edgeId}: {nodeId} has no output {name}.',
    },
    'flow.edge_field': {
        'ko': '연결 {edgeId}: {nodeId} 에 입력 필드 {field} 이 없습니다.',
        'en': 'Connection {edgeId}: {nodeId} has no input field {field}.',
    },
    'flow.edge_not_accepted': {
        'ko': '연결 {edgeId}: {nodeId}.{field} 은 연결을 받지 않는 필드입니다.',
        'en': 'Connection {edgeId}: {nodeId}.{field} does not accept connections.',
    },
    'flow.edge_type_mismatch': {
        'ko': '연결 {edgeId}: 출력 형식 {output} 과 입력 형식 {input} 이 맞지 않습니다.',
        'en': 'Connection {edgeId}: output types {output} do not match input types {input}.',
    },
    'flow.edge_handle_stale': {
        'ko': '연결 {edgeId}: 입력 형식 정보가 현재 필드와 다릅니다(다시 연결 권장).',
        'en': 'Connection {edgeId}: the stored input types differ from the current field (reconnect it).',
    },
    'flow.field_multi_edge': {
        'ko': '{nodeId}.{field} 에 연결이 {count}개입니다(하나만 허용).',
        'en': '{nodeId}.{field} has {count} connections (only one is allowed).',
    },
    'flow.required_empty': {
        'ko': '{name}: 필수 입력 {field} 이 비어 있고 연결도 없습니다.',
        'en': '{name}: the required input {field} is empty and nothing is connected to it.',
    },
    'flow.cycle': {
        'ko': '연결에 순환이 있습니다.',
        'en': 'The connections contain a cycle.',
    },
    'flow.relay_input_field': {
        'ko': '입력 컴포넌트 {nodeId} 에 value 필드가 없습니다.',
        'en': 'Input component {nodeId} has no value field.',
    },
    'flow.relay_input_unused': {
        'ko': '입력 컴포넌트가 어디에도 연결되어 있지 않습니다.',
        'en': 'The input component is not connected to anything.',
    },
    'flow.run_path': {
        'ko': '입력 컴포넌트 {input} 에서 출력 컴포넌트 {output} 까지 이어지는 실행 경로가 없습니다.',
        'en': 'There is no run path from input component {input} to output component {output}.',
    },
    'flow.secrets_masked': {
        'ko': '마스킹된 비밀 값은 적용 시 현재 Langflow 의 값으로 유지됩니다.',
        'en': 'Masked secrets keep their current Langflow values when applied.',
    },
    'flow.relay_input_fallback': {
        'ko': '입력 컴포넌트 {configured} 가 flow 에 없어 유일한 후보 {candidate} 를 사용합니다.',
        'en': 'Input component {configured} is not in the flow, so the only candidate {candidate} is used.',
    },
    'flow.relay_output_fallback': {
        'ko': '출력 컴포넌트 {configured} 가 flow 에 없어 유일한 후보 {candidate} 를 사용합니다.',
        'en': 'Output component {configured} is not in the flow, so the only candidate {candidate} is used.',
    },
    'flow.relay_not_set': {
        'ko': '(미설정)',
        'en': '(not set)',
    },
    'flow.relay_candidates': {
        'ko': ' 후보: {candidates}.',
        'en': ' Candidates: {candidates}.',
    },
    'flow.relay_input_missing': {
        'ko': '중계 서버 입력 컴포넌트 {configured} 가 없고 자동으로 정할 수 없습니다 (LANGFLOW_INPUT_COMPONENT_ID).{hint}',
        'en': 'The relay input component {configured} is missing and cannot be chosen automatically (LANGFLOW_INPUT_COMPONENT_ID).{hint}',
    },
    'flow.relay_output_missing': {
        'ko': '중계 서버 출력 컴포넌트 {configured} 가 없고 자동으로 정할 수 없습니다 (LANGFLOW_OUTPUT_COMPONENT_ID).{hint}',
        'en': 'The relay output component {configured} is missing and cannot be chosen automatically (LANGFLOW_OUTPUT_COMPONENT_ID).{hint}',
    },
    # ---- pipeline service ----
    'svc.snapshot_protected': {
        'ko': '실행용 스냅샷 flow 는 수정하지 않습니다(실행 기록의 버전 고정).',
        'en': 'Run snapshot flows are not modified (they pin the version of a recorded run).',
    },
    'svc.cloned_from': {
        'ko': '{flowId} 에서 복제',
        'en': 'Cloned from {flowId}',
    },
    'svc.validation_failed': {
        'ko': '검증 오류가 있어 적용하지 않았습니다.',
        'en': 'There are validation errors, so nothing was applied.',
    },
    'svc.conflict_updated_at': {
        'ko': '편집을 시작한 뒤 Langflow 의 flow 가 바뀌었습니다 (현재 {updatedAt}). 다시 불러와 변경을 합치세요.',
        'en': 'The flow in Langflow changed after you started editing (now {updatedAt}). Reload and merge your changes.',
    },
    'svc.conflict_hash': {
        'ko': '편집을 시작한 뒤 Langflow 의 flow 내용(실행 해시)이 바뀌었습니다. 다시 불러와 변경을 합치세요.',
        'en': 'The flow contents in Langflow (its execution hash) changed after you started editing. Reload and merge your changes.',
    },
    'svc.secret_sentinel': {
        'ko': '마스킹 값이 남아 있어 적용하지 않았습니다.',
        'en': 'A masked value was still present, so nothing was applied.',
    },
    'svc.backup_note': {
        'ko': '적용 직전 원격 flow 백업',
        'en': 'Backup of the remote flow just before applying',
    },
    'svc.snapshot_note': {
        'ko': 'AIF_Visual 적용 전 백업: {note}',
        'en': 'AIF_Visual backup before applying: {note}',
    },
    'svc.apply_not_verified': {
        'ko': 'Langflow 에 저장을 요청했지만 다시 읽은 flow 가 보낸 내용과 다릅니다. 적용이 완료되었다고 볼 수 없습니다.',
        'en': 'Langflow was asked to save, but the flow read back differs from what was sent. The apply cannot be treated as finished.',
    },
    'svc.diff_changed': {
        'ko': '변경된 컴포넌트: {names}',
        'en': 'Changed components: {names}',
    },
    'svc.diff_none': {
        'ko': '없음',
        'en': 'none',
    },
    'svc.diff_counts': {
        'ko': '추가 {added} / 삭제 {removed} / 연결 +{edgesAdded} -{edgesRemoved}',
        'en': '{added} added / {removed} removed / connections +{edgesAdded} -{edgesRemoved}',
    },
    'svc.restore_hint': {
        'ko': '백업 버전 {versionId} 으로 복원할 수 있습니다.',
        'en': 'You can restore backup version {versionId}.',
    },
    'svc.version_not_found': {
        'ko': '버전을 찾을 수 없습니다.',
        'en': 'The version was not found.',
    },
    'svc.version_mismatch': {
        'ko': '다른 flow 의 버전입니다.',
        'en': 'That version belongs to a different flow.',
    },
    'svc.restore_note': {
        'ko': '{createdAt} 버전({kind}) 복원',
        'en': 'Restored the {createdAt} version ({kind})',
    },
    'svc.no_analysis_flow_configured': {
        'ko': '분석에 사용할 flow 가 없습니다. LANGFLOW_FLOW_ID 를 설정하세요.',
        'en': 'There is no flow to analyse with. Set LANGFLOW_FLOW_ID.',
    },
    'svc.mock_fixture_note': {
        'ko': 'mock 모드: fixture 응답을 사용합니다.',
        'en': 'Mock mode: a fixture response is used.',
    },
    'svc.mock_no_local_flow': {
        'ko': 'mock 모드: 로컬 flow 를 찾지 못했습니다.',
        'en': 'Mock mode: the local flow was not found.',
    },
    'svc.relay_unresolved': {
        'ko': '실행할 flow 에서 중계 서버 입력·출력 컴포넌트를 정할 수 없습니다.',
        'en': 'The relay input and output components cannot be determined in the flow to run.',
    },
    'svc.snapshot_not_verified': {
        'ko': '실행용 스냅샷 flow 를 만들었지만 내용이 원본과 달라 실행하지 않았습니다.',
        'en': 'A run snapshot flow was created, but its contents differ from the original, so nothing was run.',
    },
    'svc.analysis_flow_not_set': {
        'ko': '분석 flow 가 설정되지 않았습니다.',
        'en': 'The analysis flow is not set.',
    },
    'svc.no_summarizer': {
        'ko': '분석 flow 에 I-node Summarizer 컴포넌트가 없습니다.',
        'en': 'The analysis flow has no I-node Summarizer component.',
    },
    'svc.templates_failed': {
        'ko': 'Langflow 컴포넌트 목록을 가져오지 못했습니다: {error}',
        'en': 'The Langflow component list could not be read: {error}',
    },
    'svc.snapshot_not_analysis_flow': {
        'ko': '실행용 스냅샷 flow 는 분석 flow 로 지정할 수 없습니다.',
        'en': 'A run snapshot flow cannot be set as the analysis flow.',
    },
    'svc.ping_ok': {
        'ko': '응답함 (version {version})',
        'en': 'Answered (version {version})',
    },
    'svc.flow_errors': {
        'ko': '{name} — 검증 오류 {count}개',
        'en': '{name} — {count} validation errors',
    },
    'svc.flow_contract_ok': {
        'ko': '쟁점 자동 선택·요약·scheme·검증 단계가 있는 v11 flow',
        'en': 'A v11 flow with issue selection, summaries, schemes and validation',
    },
    'svc.flow_contract_missing': {
        'ko': '계획서의 처리 단계가 없는 flow 입니다: {missing} (v11 flow 가져오기 필요)',
        'en': 'This flow is missing stages from the plan: {missing} (import a v11 flow)',
    },
    'svc.analysis_flow_missing': {
        'ko': '분석 flow 가 설정되지 않았습니다 (LANGFLOW_FLOW_ID).',
        'en': 'The analysis flow is not set (LANGFLOW_FLOW_ID).',
    },
    'svc.ollama_models_count': {
        'ko': '{url} — 모델 {count}개',
        'en': '{url} — {count} models',
    },
    'svc.ollama_models_needed': {
        'ko': 'flow 가 쓰는 모델 {names}',
        'en': 'Models used by the flow: {names}',
    },
    'svc.ollama_models_missing': {
        'ko': ' — 설치 안 됨: {names}',
        'en': ' — not installed: {names}',
    },
    'svc.ollama_models_ok': {
        'ko': ' 모두 설치됨',
        'en': ' all installed',
    },
    'svc.ollama_unreachable': {
        'ko': '{url} 에 연결할 수 없습니다: {name}',
        'en': 'Cannot reach {url}: {name}',
    },
    'svc.catalogs_detail': {
        'ko': '쟁점 카탈로그 v{issueVersion} ({issueCount}개) · scheme 카탈로그 v{schemeVersion} ({schemeCount}개, {schemeStatus})',
        'en': 'Issue catalogue v{issueVersion} ({issueCount} items) · scheme catalogue v{schemeVersion} ({schemeCount} items, {schemeStatus})',
    },
    # ---- pipeline service (names) ----
    'svc.production_protected': {
        'ko': '프로덕션 flow(LANGFLOW_FLOW_ID)에는 직접 적용하지 않습니다. 작업용 flow 를 복제한 뒤 적용하세요.',
        'en': 'You cannot apply directly to the production flow (LANGFLOW_FLOW_ID). Clone a working flow and apply to that.',
    },
    'svc.clone_name': {
        'ko': '{name} (작업용 {stamp})',
        'en': '{name} (working copy {stamp})',
    },
    'svc.clone_description': {
        'ko': 'AIF_Visual 파이프라인 편집 작업용 복제본. 원본: {name} ({flowId})',
        'en': 'Working copy for AIF_Visual pipeline editing. Source: {name} ({flowId})',
    },
    'svc.snapshot_name': {
        'ko': '[AIF 실행 스냅샷] {name} #{hash}',
        'en': '[AIF run snapshot] {name} #{hash}',
    },
    'svc.snapshot_description': {
        'ko': '실행 버전 고정용 스냅샷. 원본 {flowId}, 실행 해시 {hash}. 수정하지 마세요.',
        'en': 'Snapshot that pins the version for a run. Source {flowId}, execution hash {hash}. Do not edit.',
    },
    # ---- auth / 외부 결과 게시 ----
    'auth.required': {
        'ko': '인증이 필요합니다. 연동 토큰 또는 로그인 정보를 확인하세요.',
        'en': 'Authentication is required. Check the integration token or sign-in.',
    },
    'auth.forbidden': {
        'ko': '이 작업을 할 권한이 없습니다.',
        'en': 'You do not have permission for this action.',
    },
    'config.bad_auth_mode': {
        'ko': 'AIF_AUTH_MODE 값 {value} 은(는) 지원하지 않습니다. 사용할 수 있는 값: {allowed}',
        'en': 'AIF_AUTH_MODE {value} is not supported. Allowed values: {allowed}',
    },
    'schema.result_too_large': {
        'ko': '결과 그래프가 너무 큽니다(노드 {nodes}개·엣지 {edges}개 이하).',
        'en': 'The result graph is too large (at most {nodes} nodes and {edges} edges).',
    },
    'publish.too_large': {
        'ko': '요청 본문이 너무 큽니다(최대 {max} 바이트).',
        'en': 'The request body is too large (at most {max} bytes).',
    },
    'publish.run_conflict': {
        'ko': '같은 실행 ID 로 다른 내용이 이미 게시되었습니다. 새 분석이면 새 실행 ID 를 쓰세요.',
        'en': 'Different content was already published with this run ID. Use a new run ID for a new analysis.',
    },
    'publish.catalog_mismatch': {
        'ko': '실행에 쓴 카탈로그가 서버의 현재 카탈로그와 다릅니다. 서버 카탈로그로 다시 분석하세요.',
        'en': "The catalogues used for this run differ from the server's current catalogues. Run the analysis again with the server catalogues.",
    },
    'publish.catalog_issue': {
        'ko': '쟁점 카탈로그: 실행 {got} / 서버 {expected} (버전 또는 해시가 다름)',
        'en': 'Issue catalogue: run {got} / server {expected} (version or hash differs)',
    },
    'publish.catalog_scheme': {
        'ko': '스킴 카탈로그: 실행 {got} / 서버 {expected} (버전 또는 해시가 다름)',
        'en': 'Scheme catalogue: run {got} / server {expected} (version or hash differs)',
    },
    'publish.event_imported': {
        'ko': 'Langflow Desktop 에서 게시된 제안 {count}개',
        'en': '{count} proposals published from Langflow Desktop',
    },
    'publish.project_invalid': {
        'ko': '결과로 프로젝트를 만들 수 없습니다.',
        'en': 'A project could not be created from the result.',
    },
    'auth.csrf': {
        'ko': '요청을 확인할 수 없습니다(CSRF). 페이지를 새로고침한 뒤 다시 시도하세요.',
        'en': 'The request could not be verified (CSRF). Reload the page and try again.',
    },
    'auth.login_input': {
        'ko': '사용자 이름과 비밀번호를 입력하세요.',
        'en': 'Enter a user name and password.',
    },
    'auth.login_failed': {
        'ko': '사용자 이름 또는 비밀번호가 올바르지 않습니다.',
        'en': 'The user name or password is not correct.',
    },
    'auth.login_locked': {
        'ko': '로그인 실패가 여러 번 있어 잠시 막았습니다. 몇 분 뒤 다시 시도하세요.',
        'en': 'Too many failed sign-ins. Try again in a few minutes.',
    },
}
