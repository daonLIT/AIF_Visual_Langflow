"""
Langflow flow data(`data.nodes`, `data.edges`) 를 다루는 순수 함수.

원칙
- 알 수 없는 필드·컴포넌트는 삭제하지 않는다. 편집기는 원래 객체를 그대로 들고 필요한 경로만 바꾼다.
- 비밀 필드(password / SecretStrInput)는 읽을 때 마스킹하고, 저장 시 마스킹 값은 현재 원격 값으로 되돌린다.
  요청에 필드가 없다고 해서 삭제로 해석하지 않는다.
- 엣지 handle 문자열은 Langflow 형식(키 정렬 JSON 의 큰따옴표를 œ 로 치환)을 그대로 만든다.
"""
from __future__ import annotations

import copy
import json
from string import Formatter

SECRET_SENTINEL = "__AIF_SECRET_MASKED__"
PROMPT_INVALID_CHARACTERS = set(" ,.:;!?/\\()[]")
PROMPT_INVALID_NAMES = {"code", "input_variables", "output_parser", "partial_variables", "template", "template_format", "validate_template"}

KIND_LABELS = {
    "input": "입력",
    "prompt": "프롬프트",
    "llm": "언어 모델",
    "custom": "커스텀 컴포넌트",
    "output": "출력",
    "generic": "기타 컴포넌트",
}


def node_template(node: dict) -> dict:
    return ((node.get("data") or {}).get("node") or {}).get("template") or {}


def node_info(node: dict) -> dict:
    return (node.get("data") or {}).get("node") or {}


def component_kind(node: dict) -> str:
    data = node.get("data") or {}
    info = node_info(node)
    data_type = str(data.get("type") or "")
    template = info.get("template") or {}
    if data_type == "ChatOutput":
        return "output"
    if data_type in ("ChatInput", "TextInput"):
        return "input"
    if isinstance(template.get("template"), dict) and template["template"].get("_input_type") == "PromptInput":
        return "prompt"
    if data_type == "Prompt Template":
        return "prompt"
    if "ollama" in data_type.lower() or info.get("name") == "OllamaModel":
        return "llm"
    if data_type == "CustomComponent":
        return "custom"
    return "generic"


def support_info(node: dict) -> dict:
    kind = component_kind(node)
    if kind == "generic":
        return {
            "kind": kind,
            "level": "partial",
            "note": "편집기가 전용 속성 화면을 제공하지 않는 컴포넌트입니다. 위치·연결·기본 필드만 편집하고 나머지 필드는 그대로 보존합니다.",
        }
    note = {
        "input": "입력 컴포넌트. 중계 서버가 실행 시 value 를 tweaks 로 덮어씁니다.",
        "prompt": "프롬프트 텍스트를 편집하면 {변수} 에 맞춰 입력 필드가 추가·삭제됩니다.",
        "llm": "모델·온도·timeout·컨텍스트 등 모델 설정을 편집할 수 있습니다.",
        "custom": "필드 값과(고급) 실행 코드를 편집할 수 있습니다. 코드 변경은 실행되는 변경입니다.",
        "output": "최종 출력 컴포넌트. 중계 서버는 이 컴포넌트의 Message 만 사용합니다.",
    }[kind]
    return {"kind": kind, "level": "full", "note": note}


# ---- secrets ----
def is_secret_field(spec: dict) -> bool:
    return isinstance(spec, dict) and (spec.get("password") is True or spec.get("_input_type") == "SecretStrInput")


def mask_secrets(data: dict) -> tuple[dict, list[dict]]:
    """비밀 필드 값을 sentinel 로 바꾼 사본과 마스킹한 위치 목록."""
    masked = copy.deepcopy(data)
    paths = []
    for node in masked.get("nodes") or []:
        for field_name, spec in node_template(node).items():
            if is_secret_field(spec) and spec.get("value") not in (None, ""):
                spec["value"] = SECRET_SENTINEL
                paths.append({"nodeId": node.get("id"), "field": field_name})
    return masked, paths


def restore_secrets(submitted: dict, remote: dict | None) -> tuple[dict, list[str]]:
    """sentinel 값을 원격의 실제 값으로 되돌린다. 원격에 없는 노드의 sentinel 은 빈 값으로 바꾸고 경고한다."""
    restored = copy.deepcopy(submitted)
    remote_nodes = {n.get("id"): n for n in (remote or {}).get("nodes") or []}
    warnings = []
    for node in restored.get("nodes") or []:
        template = node_template(node)
        remote_template = node_template(remote_nodes.get(node.get("id"), {}))
        for field_name, spec in template.items():
            if isinstance(spec, dict) and spec.get("value") == SECRET_SENTINEL:
                original = remote_template.get(field_name, {}) if isinstance(remote_template.get(field_name), dict) else {}
                if "value" in original and original.get("value") != SECRET_SENTINEL:
                    spec["value"] = original["value"]
                else:
                    spec["value"] = ""
                    warnings.append(f"{node.get('id')}.{field_name}: 원격에 없는 비밀 값이라 비워 두었습니다.")
    return restored, warnings


def contains_sentinel(data) -> bool:
    return SECRET_SENTINEL in json.dumps(data, ensure_ascii=False)


# ---- handles / edges ----
def handle_string(obj: dict) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).replace('"', "œ")


def parse_handle(value) -> dict | None:
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return None
    try:
        parsed = json.loads(value.replace("œ", '"'))
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def make_edge(source_node: dict, output_name: str, target_node: dict, field_name: str) -> dict:
    source_data = source_node["data"]
    output = next(o for o in node_info(source_node).get("outputs") or [] if o.get("name") == output_name)
    spec = node_template(target_node)[field_name]
    source_handle = {
        "dataType": source_data.get("type"),
        "id": source_node["id"],
        "name": output_name,
        "output_types": [output.get("selected") or (output.get("types") or ["Message"])[0]],
    }
    target_handle = {
        "fieldName": field_name,
        "id": target_node["id"],
        "inputTypes": spec.get("input_types") or [],
        "type": spec.get("type"),
    }
    return {
        "animated": False,
        "className": "",
        "data": {"sourceHandle": source_handle, "targetHandle": target_handle},
        "id": f"xy-edge__{source_node['id']}{handle_string(source_handle)}-{target_node['id']}{handle_string(target_handle)}",
        "selected": False,
        "source": source_node["id"],
        "sourceHandle": handle_string(source_handle),
        "target": target_node["id"],
        "targetHandle": handle_string(target_handle),
    }


# ---- prompts ----
def prompt_variables(template: str) -> tuple[list[str], str | None]:
    """Langflow(f-string) 규칙과 같은 방식으로 변수를 뽑는다. (변수 목록, 오류 메시지)."""
    variables: list[str] = []
    try:
        for _literal, field_name, _spec, _conversion in Formatter().parse(template or ""):
            if field_name is not None and field_name not in variables:
                variables.append(field_name)
    except ValueError as error:
        return [], f"중괄호가 맞지 않습니다 ({error}). 문자 그대로의 중괄호는 {{{{ }}}} 로 두 번 쓰세요."
    for name in variables:
        if name == "":
            return variables, "빈 변수 {} 가 있습니다."
        if name[0].isdigit() or any(char in PROMPT_INVALID_CHARACTERS for char in name) or '"' in name or "'" in name:
            return variables, f"변수 이름으로 쓸 수 없는 형식입니다: {{{name}}}. JSON 예시의 중괄호는 {{{{ }}}} 로 두 번 쓰세요."
        if name in PROMPT_INVALID_NAMES:
            return variables, f"예약된 이름은 변수로 쓸 수 없습니다: {name}"
    return variables, None


def default_prompt_field(name: str, value: str = "") -> dict:
    """lfx DefaultPromptField(name).to_dict() 와 같은 구조 (Langflow 1.11 기준)."""
    return {
        "field_type": "str",
        "required": False,
        "placeholder": "",
        "list": False,
        "show": True,
        "multiline": True,
        "value": value,
        "fileTypes": [],
        "file_path": "",
        "name": name,
        "display_name": name,
        "advanced": False,
        "api_editable": False,
        "input_types": ["Message"],
        "dynamic": False,
        "info": "",
        "load_from_db": False,
        "title_case": False,
        "type": "str",
    }


# ---- validation ----
def _issue(level: str, code: str, message: str, **extra) -> dict:
    return {"level": level, "code": code, "message": message, **{k: v for k, v in extra.items() if v is not None}}


def _is_empty(value) -> bool:
    return value is None or value == "" or value == [] or value == {}


def validate_flow_data(data: dict, *, input_component_id: str | None = None, output_component_id: str | None = None) -> list[dict]:
    issues: list[dict] = []
    if not isinstance(data, dict):
        return [_issue("error", "BAD_DATA", "flow data 가 객체가 아닙니다.")]
    nodes = data.get("nodes")
    edges = data.get("edges")
    if not isinstance(nodes, list) or not isinstance(edges, list):
        return [_issue("error", "BAD_DATA", "flow data 에 nodes / edges 배열이 필요합니다.")]

    by_id: dict[str, dict] = {}
    for index, node in enumerate(nodes):
        node_id = node.get("id") if isinstance(node, dict) else None
        if not isinstance(node_id, str) or not node_id:
            issues.append(_issue("error", "NODE_ID", f"nodes[{index}] 에 id 가 없습니다."))
            continue
        if node_id in by_id:
            issues.append(_issue("error", "DUPLICATE_NODE", f"중복 노드 id: {node_id}", nodeId=node_id))
        by_id[node_id] = node
        if (node.get("data") or {}).get("id") not in (None, node_id):
            issues.append(_issue("error", "NODE_DATA_ID", f"{node_id}: data.id 가 노드 id 와 다릅니다.", nodeId=node_id))
        if not isinstance(node_info(node).get("template"), dict):
            # 메모(note) 노드 등 template 없는 노드는 그대로 둔다.
            if node.get("type") == "genericNode":
                issues.append(_issue("error", "NO_TEMPLATE", f"{node_id}: 컴포넌트 template 이 없습니다.", nodeId=node_id))
            continue
        if support_info(node)["level"] != "full":
            issues.append(
                _issue(
                    "info",
                    "PARTIAL_SUPPORT",
                    f"{node_info(node).get('display_name') or node_id}: 전용 속성 편집을 지원하지 않는 컴포넌트입니다(필드 보존).",
                    nodeId=node_id,
                )
            )
        if component_kind(node) == "prompt":
            template_spec = node_template(node).get("template") or {}
            variables, error = prompt_variables(str(template_spec.get("value") or ""))
            if error:
                issues.append(_issue("error", "PROMPT_SYNTAX", f"{node_id}: {error}", nodeId=node_id, field="template"))
            else:
                template = node_template(node)
                custom = (node_info(node).get("custom_fields") or {}).get("template") or []
                for name in variables:
                    if not isinstance(template.get(name), dict):
                        issues.append(
                            _issue("error", "PROMPT_FIELD_MISSING", f"{node_id}: 프롬프트 변수 {{{name}}} 의 입력 필드가 없습니다.", nodeId=node_id, field=name)
                        )
                    elif name not in custom:
                        issues.append(
                            _issue("warning", "PROMPT_CUSTOM_FIELDS", f"{node_id}: custom_fields 에 {name} 이 없습니다.", nodeId=node_id, field=name)
                        )
                for name in custom:
                    if name not in variables:
                        issues.append(
                            _issue("warning", "PROMPT_FIELD_UNUSED", f"{node_id}: 프롬프트에서 쓰지 않는 변수 필드 {name} 가 남아 있습니다.", nodeId=node_id, field=name)
                        )

    connected_fields: dict[tuple[str, str], int] = {}
    adjacency: dict[str, list[str]] = {}
    for index, edge in enumerate(edges):
        if not isinstance(edge, dict):
            issues.append(_issue("error", "EDGE", f"edges[{index}] 가 객체가 아닙니다."))
            continue
        edge_id = edge.get("id")
        source_id, target_id = edge.get("source"), edge.get("target")
        if source_id not in by_id or target_id not in by_id:
            issues.append(_issue("error", "EDGE_ENDPOINT", f"연결 {edge_id}: 없는 노드를 가리킵니다.", edgeId=edge_id))
            continue
        source_handle = parse_handle(edge.get("sourceHandle"))
        target_handle = parse_handle(edge.get("targetHandle"))
        if source_handle is None or target_handle is None:
            issues.append(_issue("error", "EDGE_HANDLE", f"연결 {edge_id}: handle 을 해석할 수 없습니다.", edgeId=edge_id))
            continue
        data_handles = edge.get("data") or {}
        if data_handles.get("sourceHandle") not in (None, source_handle) or data_handles.get("targetHandle") not in (None, target_handle):
            issues.append(_issue("warning", "EDGE_HANDLE_MISMATCH", f"연결 {edge_id}: handle 문자열과 data 가 다릅니다.", edgeId=edge_id))
        if source_handle.get("id") != source_id or target_handle.get("id") != target_id:
            issues.append(_issue("error", "EDGE_HANDLE_ID", f"연결 {edge_id}: handle 의 id 가 노드와 다릅니다.", edgeId=edge_id))

        outputs = node_info(by_id[source_id]).get("outputs") or []
        output = next((o for o in outputs if o.get("name") == source_handle.get("name")), None)
        if output is None:
            issues.append(
                _issue("error", "EDGE_OUTPUT", f"연결 {edge_id}: {source_id} 에 출력 {source_handle.get('name')} 이 없습니다.", edgeId=edge_id, nodeId=source_id)
            )
            continue
        spec = node_template(by_id[target_id]).get(target_handle.get("fieldName"))
        field_name = target_handle.get("fieldName")
        if not isinstance(spec, dict):
            issues.append(
                _issue("error", "EDGE_FIELD", f"연결 {edge_id}: {target_id} 에 입력 필드 {field_name} 이 없습니다.", edgeId=edge_id, nodeId=target_id, field=field_name)
            )
            continue
        input_types = spec.get("input_types") or []
        output_types = output.get("types") or []
        if not input_types and spec.get("type") != "other":
            issues.append(
                _issue("error", "EDGE_NOT_ACCEPTED", f"연결 {edge_id}: {target_id}.{field_name} 은 연결을 받지 않는 필드입니다.", edgeId=edge_id, nodeId=target_id, field=field_name)
            )
        elif input_types and not set(output_types) & set(input_types):
            issues.append(
                _issue(
                    "error",
                    "EDGE_TYPE",
                    f"연결 {edge_id}: 출력 형식 {output_types} 과 입력 형식 {input_types} 이 맞지 않습니다.",
                    edgeId=edge_id,
                    nodeId=target_id,
                    field=field_name,
                )
            )
        if sorted(target_handle.get("inputTypes") or []) != sorted(input_types):
            issues.append(
                _issue("warning", "EDGE_HANDLE_STALE", f"연결 {edge_id}: 입력 형식 정보가 현재 필드와 다릅니다(다시 연결 권장).", edgeId=edge_id)
            )
        key = (target_id, field_name)
        connected_fields[key] = connected_fields.get(key, 0) + 1
        adjacency.setdefault(source_id, []).append(target_id)

    for (target_id, field_name), count in connected_fields.items():
        spec = node_template(by_id[target_id]).get(field_name) or {}
        if count > 1 and not spec.get("list"):
            issues.append(
                _issue("error", "FIELD_MULTI_EDGE", f"{target_id}.{field_name} 에 연결이 {count}개입니다(하나만 허용).", nodeId=target_id, field=field_name)
            )

    for node_id, node in by_id.items():
        if node_id == input_component_id:
            continue
        for field_name, spec in node_template(node).items():
            if not isinstance(spec, dict) or field_name.startswith("_") or field_name == "code":
                continue
            if spec.get("required") and spec.get("show", True) and _is_empty(spec.get("value")):
                if (node_id, field_name) not in connected_fields and not spec.get("load_from_db"):
                    issues.append(
                        _issue(
                            "warning",
                            "REQUIRED_EMPTY",
                            f"{node_info(node).get('display_name') or node_id}: 필수 입력 {spec.get('display_name') or field_name} 이 비어 있고 연결도 없습니다.",
                            nodeId=node_id,
                            field=field_name,
                        )
                    )

    # 순환 검사 (Langflow 일반 flow 는 순환을 허용하지 않는다)
    state: dict[str, int] = {}

    def visit(node_id: str) -> bool:
        state[node_id] = 1
        for nxt in adjacency.get(node_id, []):
            if state.get(nxt) == 1 or (state.get(nxt) is None and visit(nxt)):
                return True
        state[node_id] = 2
        return False

    for node_id in by_id:
        if state.get(node_id) is None and visit(node_id):
            issues.append(_issue("error", "CYCLE", "연결에 순환이 있습니다."))
            break

    if input_component_id or output_component_id:
        relay = resolve_relay(data, input_component_id, output_component_id)
        for note in relay["notes"]:
            issues.append(_issue("warning", "RELAY_AUTO", note))
        for error in relay["errors"]:
            issues.append(_issue("error", error["code"], error["message"]))
        resolved_input, resolved_output = relay["inputComponentId"], relay["outputComponentId"]
        if resolved_input:
            node = by_id[resolved_input]
            if "value" not in node_template(node):
                issues.append(_issue("error", "RELAY_INPUT_FIELD", f"입력 컴포넌트 {resolved_input} 에 value 필드가 없습니다.", nodeId=resolved_input))
            elif resolved_input not in adjacency:
                issues.append(_issue("warning", "RELAY_INPUT_UNUSED", "입력 컴포넌트가 어디에도 연결되어 있지 않습니다.", nodeId=resolved_input))
        if resolved_input and resolved_output:
            # 실행 경로: 입력에서 출력까지 연결이 이어져야 한다.
            seen = {resolved_input}
            stack = [resolved_input]
            while stack:
                current = stack.pop()
                for nxt in adjacency.get(current, []):
                    if nxt not in seen:
                        seen.add(nxt)
                        stack.append(nxt)
            if resolved_output not in seen:
                issues.append(_issue("error", "RUN_PATH", f"입력 컴포넌트 {resolved_input} 에서 출력 컴포넌트 {resolved_output} 까지 이어지는 실행 경로가 없습니다."))
    if contains_sentinel({k: v for k, v in data.items() if k in ("nodes", "edges")}):
        issues.append(_issue("info", "SECRETS_MASKED", "마스킹된 비밀 값은 적용 시 현재 Langflow 의 값으로 유지됩니다."))
    return issues


def resolve_relay(data: dict, input_component_id: str | None, output_component_id: str | None) -> dict:
    """
    중계 서버가 쓸 입력·출력 컴포넌트를 flow 별로 정한다.
    설정값이 flow 에 있으면 그대로 쓰고, 없으면(Langflow 가 가져오면서 ID 를 새로 붙인 경우) 후보가 하나일 때만 자동으로 쓴다.
    """
    nodes = [n for n in data.get("nodes") or [] if isinstance(n, dict) and isinstance(n.get("id"), str)]
    by_id = {n["id"]: n for n in nodes}
    adjacency: dict[str, list[str]] = {}
    targets: set[tuple[str, str]] = set()
    for edge in data.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        adjacency.setdefault(edge.get("source"), []).append(edge.get("target"))
        handle = parse_handle((edge.get("data") or {}).get("targetHandle") or edge.get("targetHandle")) or {}
        targets.add((edge.get("target"), handle.get("fieldName")))
    result = {"inputComponentId": None, "outputComponentId": None, "notes": [], "errors": []}

    if input_component_id and input_component_id in by_id:
        result["inputComponentId"] = input_component_id
    else:
        candidates = relay_input_candidates(by_id, adjacency, dict.fromkeys(targets, 1))
        if len(candidates) == 1:
            result["inputComponentId"] = candidates[0]
            result["notes"].append(f"입력 컴포넌트 {input_component_id or '(미설정)'} 가 flow 에 없어 유일한 후보 {candidates[0]} 를 사용합니다.")
        else:
            hint = f" 후보: {', '.join(candidates)}." if candidates else ""
            result["errors"].append(
                {"code": "RELAY_INPUT", "message": f"중계 서버 입력 컴포넌트 {input_component_id} 가 없고 자동으로 정할 수 없습니다 (LANGFLOW_INPUT_COMPONENT_ID).{hint}"}
            )

    if output_component_id and output_component_id in by_id:
        result["outputComponentId"] = output_component_id
    else:
        candidates = [node_id for node_id, node in by_id.items() if component_kind(node) == "output"]
        if len(candidates) == 1:
            result["outputComponentId"] = candidates[0]
            result["notes"].append(f"출력 컴포넌트 {output_component_id or '(미설정)'} 가 flow 에 없어 유일한 후보 {candidates[0]} 를 사용합니다.")
        else:
            hint = f" 후보: {', '.join(candidates)}." if candidates else ""
            result["errors"].append(
                {"code": "RELAY_OUTPUT", "message": f"중계 서버 출력 컴포넌트 {output_component_id} 가 없고 자동으로 정할 수 없습니다 (LANGFLOW_OUTPUT_COMPONENT_ID).{hint}"}
            )
    return result


def execution_hash(data: dict) -> str:
    """
    실행에 영향을 주는 내용(컴포넌트 종류·필드 값·출력 선택·연결)의 해시.
    위치·선택 표시·flow 별 내부 키(`_frontend_node_flow_id` 등 `_` 로 시작하는 필드)는 제외해
    같은 내용의 복제본·스냅샷이 같은 해시를 갖게 한다.
    """
    import hashlib

    nodes = []
    for node in data.get("nodes") or []:
        if not isinstance(node, dict):
            continue
        info = node_info(node)
        template = info.get("template") or {}
        nodes.append(
            {
                "id": node.get("id"),
                "type": (node.get("data") or {}).get("type"),
                "fields": {k: v.get("value") for k, v in template.items() if isinstance(v, dict) and not k.startswith("_")},
                "outputs": [[o.get("name"), o.get("selected")] for o in info.get("outputs") or [] if isinstance(o, dict)],
            }
        )
    edges = []
    for edge in data.get("edges") or []:
        if not isinstance(edge, dict):
            continue
        source = parse_handle((edge.get("data") or {}).get("sourceHandle") or edge.get("sourceHandle")) or {}
        target = parse_handle((edge.get("data") or {}).get("targetHandle") or edge.get("targetHandle")) or {}
        edges.append([edge.get("source"), source.get("name"), edge.get("target"), target.get("fieldName")])
    payload = {"nodes": sorted(nodes, key=lambda n: str(n["id"])), "edges": sorted(edges, key=lambda e: [str(x) for x in e])}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")).hexdigest()


MODEL_FIELDS = ("model_name", "base_url", "temperature", "num_ctx", "timeout")


def model_settings(data: dict) -> list[dict]:
    """flow 안의 모델 설정 (실행 기록에 고정). 비밀 필드는 넣지 않는다."""
    result = []
    for node in data.get("nodes") or []:
        template = node_template(node)
        if not isinstance(template.get("model_name"), dict):
            continue
        entry = {"componentId": node.get("id"), "displayName": node_info(node).get("display_name")}
        for field_name in MODEL_FIELDS:
            spec = template.get(field_name)
            if isinstance(spec, dict) and not is_secret_field(spec):
                entry[field_name] = spec.get("value")
        result.append(entry)
    return result


def relay_input_candidates(by_id: dict[str, dict], adjacency: dict[str, list[str]], connected: dict) -> list[str]:
    """들어오는 연결이 없고 value 필드가 있으며 다른 컴포넌트로 나가는 연결이 있는 컴포넌트 (입력 후보)."""
    targets = {node_id for node_id, _field in connected}
    return [
        node_id
        for node_id, node in by_id.items()
        if "value" in node_template(node) and node_id not in targets and adjacency.get(node_id)
    ]


def summarize(data: dict) -> dict:
    nodes = data.get("nodes") or []
    kinds: dict[str, int] = {}
    for node in nodes:
        kind = component_kind(node)
        kinds[kind] = kinds.get(kind, 0) + 1
    return {"nodeCount": len(nodes), "edgeCount": len(data.get("edges") or []), "kinds": kinds}
