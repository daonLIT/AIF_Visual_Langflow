"""
Langflow(lfx) 없이 flow 커스텀 컴포넌트 코드를 실행하기 위한 최소 스텁.

컴포넌트 파일을 그대로 import 해서 순수 로직(파싱·조립·오류 기록)을 검증한다.
실제 Langflow 에서의 template 생성·실행은 langflow/tools/build_component_nodes.py 와 실서버 테스트로 확인한다.
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent.parent
COMPONENTS = PROJECT / "langflow" / "components"


class Message:
    def __init__(self, text: str = ""):
        self.text = text


class Component:
    def __init__(self, **values):
        self.status = None
        for key, value in values.items():
            setattr(self, key, value)


def _input(**kwargs):
    return kwargs


def install() -> None:
    if "lfx" in sys.modules and getattr(sys.modules["lfx"], "__stub__", False):
        return
    lfx = types.ModuleType("lfx")
    lfx.__stub__ = True
    custom = types.ModuleType("lfx.custom")
    custom.Component = Component
    io = types.ModuleType("lfx.io")
    for name in (
        "MessageTextInput",
        "MultilineInput",
        "StrInput",
        "IntInput",
        "FloatInput",
        "DropdownInput",
        "Output",
    ):
        setattr(io, name, _input)
    schema = types.ModuleType("lfx.schema")
    message = types.ModuleType("lfx.schema.message")
    message.Message = Message
    sys.modules.update(
        {"lfx": lfx, "lfx.custom": custom, "lfx.io": io, "lfx.schema": schema, "lfx.schema.message": message}
    )


def load_component(file_name: str, class_name: str):
    install()
    path = COMPONENTS / file_name
    spec = importlib.util.spec_from_file_location(f"flow_component_{path.stem}", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return getattr(module, class_name), module
