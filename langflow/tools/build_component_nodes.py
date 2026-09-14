"""
Langflow 설치본의 Python 으로 실행하는 보조 스크립트 (lfx 필요).

stdin  : {"components": [{"key", "code"}], "prompts": [{"key", "template", "frontend_node", "sample": {var: value}}]}
stdout : {"components": {key: frontend_node}, "prompts": {key: {"frontend_node", "variables", "rendered"}}}

- 커스텀 컴포넌트: lfx 의 build_custom_component_template 으로 실제 Langflow 가 만드는 template/outputs 를 얻는다.
- 프롬프트: process_prompt_template 으로 변수 필드를 갱신하고, 실행 시와 같은 f-string 포맷으로 렌더링해 본다.
  (JSON 예시의 중괄호를 이중으로 쓰지 않으면 여기서 실패한다.)
"""
from __future__ import annotations

import io
import json
import sys


def main() -> int:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    real_stdout = sys.stdout
    sys.stdout = io.StringIO()  # 라이브러리 초기화 메시지가 JSON 출력에 섞이지 않게 한다.
    try:
        from langchain_core.prompts import PromptTemplate
        from lfx.base.prompts.api_utils import process_prompt_template
        from lfx.custom.custom_component.component import Component
        from lfx.custom.utils import build_custom_component_template

        result: dict = {"components": {}, "prompts": {}}
        for item in request.get("components", []):
            frontend_node, _instance = build_custom_component_template(Component(_code=item["code"]))
            result["components"][item["key"]] = frontend_node
        for item in request.get("prompts", []):
            node = item["frontend_node"]
            node["template"]["template"]["value"] = item["template"]
            custom_fields = node.setdefault("custom_fields", {})
            variables = process_prompt_template(
                template=item["template"],
                name="template",
                custom_fields=custom_fields,
                frontend_node_template=node["template"],
                is_mustache=False,
            )
            sample = {name: item.get("sample", {}).get(name, f"<{name}>") for name in variables}
            rendered = PromptTemplate.from_template(item["template"], template_format="f-string").format(**sample)
            result["prompts"][item["key"]] = {"frontend_node": node, "variables": list(variables), "rendered": rendered}
    finally:
        sys.stdout = real_stdout
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
