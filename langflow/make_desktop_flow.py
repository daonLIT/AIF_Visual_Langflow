"""
v11 flow 에서 Langflow Desktop 용 flow 를 만든다. 원래 v11 flow 와 make_v11_flow.py 는 바꾸지 않는다.

실행 (프로젝트 루트에서):
    python langflow/make_desktop_flow.py
    python langflow/make_desktop_flow.py --offline      # 캐시(components/_built_desktop_nodes.json)만 사용

바뀌는 부분
    Judgment Text Input ─▶ AIF Run Context ─(Splitter Input)─▶ 0. Judgment Splitter ─▶ (v11 과 같은 분석 단계) ─▶ 7. Result Validator
                                 └──────(Run Context)──────────────────────────────────────────────────┐        │
                                                                                                          ▼        ▼
                                                                                                  8. AIF Publish ─▶ Final Output
- 입력 노드에는 판결문 원문만 넣는다. 카탈로그는 AIF Run Context 가 중앙 서버에서 읽어 버전·해시와 함께 고정한다.
- AIF Publish 는 최종 출력 바로 앞에 있다. 게시 단계가 빠진 채 flow 가 끝나지 않는다.
- 서버 주소·토큰은 flow 에 넣지 않는다(환경변수 AIF_API_BASE, AIF_PUBLISH_TOKEN, AIF_OUTBOX_DIR — Desktop 셸이 넣어 준다).
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import make_v11_flow as v11  # noqa: E402

SOURCE = v11.TARGET
TARGET = ROOT / "TopDown_Judgment_to_AIF_v11_Desktop.json"
CACHE = v11.COMPONENTS / "_built_desktop_nodes.json"

CONTEXT_ID = "CustomComponent-Ctx12"
PUBLISH_ID = "CustomComponent-Pub12"
CUSTOM = {
    "context": ("aif_run_context.py", CONTEXT_ID, "AIF Run Context", (380, 700), None),
    "publish": ("aif_publish.py", PUBLISH_ID, "8. AIF Publish", (3980, 300), "publish_result"),
}
INPUT_PLACEHOLDER = "여기에 판결문 원문을 붙여 넣으세요. 공백·줄바꿈은 그대로 전달됩니다."


def build_nodes(python: Path, offline: bool) -> dict:
    request = {
        "components": [{"key": key, "code": (v11.COMPONENTS / spec[0]).read_text(encoding="utf-8")} for key, spec in CUSTOM.items()],
        "prompts": [],
    }
    fingerprint = hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    if CACHE.exists():
        cached = json.loads(CACHE.read_text(encoding="utf-8"))
        if cached.get("fingerprint") == fingerprint:
            return cached["result"]
    if offline or not python.exists():
        raise SystemExit(f"캐시가 현재 코드와 맞지 않고 Langflow Python 을 찾을 수 없습니다: {python}")
    built = v11.run_langflow_helper(python, request)
    CACHE.write_text(json.dumps({"fingerprint": fingerprint, "result": built}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    return built


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--langflow-python", type=Path, default=Path(os.environ.get("LANGFLOW_PYTHON", v11.DEFAULT_LANGFLOW_PYTHON)))
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()

    flow = json.loads(SOURCE.read_text(encoding="utf-8"))
    nodes = {node["id"]: node for node in flow["data"]["nodes"]}
    for node_id in (v11.INPUT_ID, v11.SPLITTER_ID, v11.VALIDATOR_ID, v11.OUTPUT_ID):
        if node_id not in nodes:
            raise SystemExit(f"v11 flow 에 예상한 노드가 없습니다: {node_id}")

    built = build_nodes(args.langflow_python, args.offline)
    for key, (_file, node_id, display, position, selected) in CUSTOM.items():
        nodes[node_id] = v11.custom_node(node_id, built["components"][key], position, display, selected)

    input_node = nodes[v11.INPUT_ID]
    input_node["data"]["node"]["display_name"] = "Judgment Text Input"
    input_node["data"]["node"]["description"] = "판결문 원문을 붙여 넣으세요. 사건번호·제목은 AIF Run Context 에 넣습니다."
    input_node["data"]["node"]["template"]["value"]["value"] = INPUT_PLACEHOLDER
    nodes[v11.OUTPUT_ID]["position"] = {"x": 4380, "y": 300}

    replaced = {
        (v11.INPUT_ID, v11.SPLITTER_ID),  # 입력 → Splitter 는 Run Context 를 거친다
        (v11.VALIDATOR_ID, v11.OUTPUT_ID),  # Validator → 출력 사이에 Publish 가 들어간다
    }
    edges = [edge for edge in flow["data"]["edges"] if (edge["source"], edge["target"]) not in replaced]
    removed = len(flow["data"]["edges"]) - len(edges)
    if removed != 2:
        raise SystemExit(f"바꿀 연결 2개를 찾지 못했습니다(찾은 수 {removed}).")
    edges += [
        v11.make_edge(nodes, v11.INPUT_ID, "message", CONTEXT_ID, "judgment"),
        v11.make_edge(nodes, CONTEXT_ID, "payload", v11.SPLITTER_ID, "payload"),
        v11.make_edge(nodes, v11.VALIDATOR_ID, "final_graph", PUBLISH_ID, "final_graph"),
        v11.make_edge(nodes, CONTEXT_ID, "context", PUBLISH_ID, "run_context"),
        v11.make_edge(nodes, PUBLISH_ID, "publish_result", v11.OUTPUT_ID, "input_value"),
    ]

    # 최종 출력으로 가는 경로에 Publish 가 있어야 한다(연결 안 된 부수 노드로 두면 실행이 생략될 수 있다).
    into_output = [edge["source"] for edge in edges if edge["target"] == v11.OUTPUT_ID]
    if into_output != [PUBLISH_ID]:
        raise SystemExit(f"최종 출력 입력이 Publish 하나가 아닙니다: {into_output}")

    flow["data"]["nodes"] = list(nodes.values())
    flow["data"]["edges"] = edges
    flow["id"] = str(uuid.uuid5(uuid.NAMESPACE_URL, "aif-visual-langflow/v11-desktop"))
    flow["name"] = "TopDown_Judgment_to_AIF_v11_Desktop"
    flow["description"] = (
        "Langflow Desktop version of v11: paste the judgment → AIF Run Context reads and pins the server catalogues → "
        "the v11 analysis stages → result validation → AIF Publish saves the result to the central AIF server and "
        "outputs a link that opens it in the AIF review screen."
    )
    flow["tags"] = sorted(set(flow.get("tags", [])) | {"desktop", "publish"})
    TARGET.write_text(json.dumps(flow, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    print(f"wrote {TARGET.name}: {len(nodes)} nodes / {len(edges)} edges")


if __name__ == "__main__":
    main()
