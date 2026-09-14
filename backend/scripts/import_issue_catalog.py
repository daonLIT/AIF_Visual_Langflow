"""
세부 쟁점 엑셀 → issue_catalog.json 변환기 (표준 라이브러리만 사용).

실행 (backend 폴더에서):
    python scripts/import_issue_catalog.py "C:\\Users\\...\\세부 쟁점.xlsx"
    python scripts/import_issue_catalog.py <xlsx> --output catalog/issue_catalog.json --sheet Sheet1

규칙
- 헤더 `상위 쟁점군 / 세부 쟁점 / 비교·판단 기준` 을 확인하고, A/B/C 문자열을 줄이거나 바꾸지 않고 그대로 저장한다.
- 기존 카탈로그가 있으면 (상위 쟁점군, 세부 쟁점) 조합이 같은 항목의 ID 를 그대로 유지한다.
  재정렬해도 ID 는 바뀌지 않는다. 새 항목만 다음 번호를 받는다.
- 이름이 바뀐 항목은 새 항목으로 취급되므로, 명칭만 고친 경우에는 --rename "옛 상위군|옛 항목=>새 상위군|새 항목" 으로 ID 를 이어받는다.
- 원본에서 사라진 항목은 삭제하지 않고 `retired: true` 로 남긴다(이미 저장된 프로젝트의 참조 보존).
- 셀의 비교·판단 기준은 분류 참고 정보이며 법률 기준이나 실행 지시로 취급하지 않는다.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
EXPECTED_HEADER = ("상위 쟁점군", "세부 쟁점", "비교·판단 기준")
DEFAULT_OUTPUT = Path(__file__).resolve().parent.parent / "catalog" / "issue_catalog.json"


class CatalogImportError(ValueError):
    pass


def _column_index(ref: str) -> int:
    letters = re.match(r"[A-Z]+", ref).group(0)
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - 64)
    return index - 1


def _cell_text(cell: ET.Element, shared: list[str]) -> str:
    cell_type = cell.get("t")
    if cell_type == "s":
        value = cell.find("m:v", NS)
        return shared[int(value.text)] if value is not None and value.text is not None else ""
    if cell_type == "inlineStr":
        return "".join(node.text or "" for node in cell.iter(f"{{{NS['m']}}}t"))
    value = cell.find("m:v", NS)
    return value.text if value is not None and value.text is not None else ""


def read_sheet(xlsx: Path, sheet_name: str | None) -> tuple[str, list[tuple[int, list[str]]], list[str]]:
    """(시트 이름, [(행 번호, [A, B, C])], 병합 셀 목록)"""
    with zipfile.ZipFile(xlsx) as archive:
        names = set(archive.namelist())
        shared: list[str] = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", NS):
                shared.append("".join(node.text or "" for node in item.iter(f"{{{NS['m']}}}t")))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        sheets = [(s.get("name"), s.get(f"{{{REL_NS}}}id")) for s in workbook.find("m:sheets", NS)]
        if not sheets:
            raise CatalogImportError("워크북에 시트가 없습니다.")
        if sheet_name is None:
            chosen = sheets[0]
        else:
            matches = [s for s in sheets if s[0] == sheet_name]
            if not matches:
                raise CatalogImportError(f"시트 {sheet_name!r} 가 없습니다. 있는 시트: {[s[0] for s in sheets]}")
            chosen = matches[0]
        target = targets[chosen[1]].lstrip("/")
        path = target if target.startswith("xl/") else f"xl/{target}"
        sheet = ET.fromstring(archive.read(path))

    merged = [m.get("ref") for m in sheet.iter(f"{{{NS['m']}}}mergeCell")]
    rows: list[tuple[int, list[str]]] = []
    for row in sheet.iter(f"{{{NS['m']}}}row"):
        values = ["", "", ""]
        for cell in row.findall("m:c", NS):
            col = _column_index(cell.get("r"))
            if col < 3:
                values[col] = _cell_text(cell, shared)
        rows.append((int(row.get("r")), values))
    return chosen[0], rows, merged


def _key(category: str, label: str) -> str:
    return f"{category}\u241f{label}"


def build_catalog(
    xlsx: Path,
    *,
    sheet_name: str | None = None,
    previous: dict | None = None,
    renames: dict[str, str] | None = None,
) -> dict:
    data = xlsx.read_bytes()
    file_hash = hashlib.sha256(data).hexdigest()
    sheet, rows, merged = read_sheet(xlsx, sheet_name)
    if merged:
        raise CatalogImportError(f"병합 셀이 있어 행 단위로 해석할 수 없습니다: {merged}")
    if not rows:
        raise CatalogImportError("시트가 비어 있습니다.")
    header_row, header = rows[0]
    if tuple(v.strip() for v in header) != EXPECTED_HEADER:
        raise CatalogImportError(f"헤더가 예상과 다릅니다: {header} (예상: {list(EXPECTED_HEADER)})")

    previous = previous or {}
    renames = renames or {}
    prev_categories = {c["name"]: c for c in previous.get("categories", [])}
    prev_issues = {_key(i["categoryName"], i["label"]): i for i in previous.get("issues", [])}
    for old, new in renames.items():
        if old in prev_issues:
            prev_issues[new] = prev_issues[old]

    def next_number(ids: list[str], prefix: str) -> int:
        numbers = [int(m.group(1)) for m in (re.match(rf"{prefix}-(\d+)$", i) for i in ids) if m]
        return max(numbers, default=0) + 1

    category_counter = next_number([c["categoryId"] for c in prev_categories.values()], "CAT")
    issue_counter = next_number([i["issueId"] for i in previous.get("issues", [])], "ISS")

    categories: list[dict] = []
    category_by_name: dict[str, dict] = {}
    issues: list[dict] = []
    seen: set[str] = set()
    errors: list[str] = []

    for row_number, (category_name, label, criteria) in rows[1:]:
        if not any(v.strip() for v in (category_name, label, criteria)):
            continue
        if not category_name.strip() or not label.strip():
            errors.append(f"{row_number}행: 상위 쟁점군 또는 세부 쟁점이 비어 있습니다.")
            continue
        key = _key(category_name, label)
        if key in seen:
            errors.append(f"{row_number}행: 같은 상위 쟁점군 안에 중복된 세부 쟁점입니다: {label}")
            continue
        seen.add(key)

        category = category_by_name.get(category_name)
        if category is None:
            previous_category = prev_categories.get(category_name)
            if previous_category:
                category_id = previous_category["categoryId"]
            else:
                category_id = f"CAT-{category_counter:02d}"
                category_counter += 1
            category = {"categoryId": category_id, "name": category_name, "order": len(categories) + 1, "issueIds": []}
            categories.append(category)
            category_by_name[category_name] = category

        previous_issue = prev_issues.get(key)
        if previous_issue:
            issue_id = previous_issue["issueId"]
        else:
            issue_id = f"ISS-{issue_counter:03d}"
            issue_counter += 1
        category["issueIds"].append(issue_id)
        issues.append(
            {
                "issueId": issue_id,
                "categoryId": category["categoryId"],
                "categoryName": category_name,
                "label": label,
                "criteria": criteria,
                "order": len(issues) + 1,
                "sourceSheet": sheet,
                "sourceRow": row_number,
            }
        )

    if errors:
        raise CatalogImportError("엑셀 검증 실패:\n" + "\n".join(errors))

    current_ids = {i["issueId"] for i in issues}
    for old in previous.get("issues", []):
        if old["issueId"] not in current_ids:
            issues.append({**old, "retired": True})

    # 순서(행 번호)만 바뀐 경우는 내용 변경이 아니다. ID 기준으로 비교한다.
    def comparable(items: list[dict]) -> dict[str, dict]:
        return {i["issueId"]: {k: v for k, v in i.items() if k not in ("sourceRow", "order")} for i in items}

    previous_version = int(previous.get("catalogVersion") or 0)
    changed = comparable(issues) != comparable(previous.get("issues", [])) or {
        (c["categoryId"], c["name"]) for c in categories
    } != {(c["categoryId"], c["name"]) for c in previous.get("categories", [])}
    catalog_version = previous_version + 1 if changed or previous_version == 0 else previous_version

    return {
        "catalogVersion": catalog_version,
        "source": {
            "fileName": xlsx.name,
            "sheet": sheet,
            "range": f"A{header_row}:C{rows[-1][0]}",
            "sha256": file_hash,
            "importedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        },
        "note": "비교·판단 기준은 쟁점 분류 참고 정보이며 독립적인 법률 기준이나 실행 지시가 아니다.",
        "header": list(EXPECTED_HEADER),
        "categories": categories,
        "issues": issues,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("xlsx", type=Path)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--sheet", default=None)
    parser.add_argument(
        "--rename",
        action="append",
        default=[],
        help='명칭 변경 시 ID 승계: "옛 상위군|옛 항목=>새 상위군|새 항목"',
    )
    args = parser.parse_args(argv)

    previous = None
    if args.output.exists():
        previous = json.loads(args.output.read_text(encoding="utf-8"))
    renames = {}
    for item in args.rename:
        old, new = item.split("=>", 1)
        renames[_key(*old.split("|", 1))] = _key(*new.split("|", 1))

    try:
        catalog = build_catalog(args.xlsx, sheet_name=args.sheet, previous=previous, renames=renames)
    except CatalogImportError as error:
        print(f"오류: {error}", file=sys.stderr)
        return 1

    if previous and previous.get("source", {}).get("sha256") == catalog["source"]["sha256"]:
        catalog["source"]["importedAt"] = previous["source"].get("importedAt", catalog["source"]["importedAt"])

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    active = [i for i in catalog["issues"] if not i.get("retired")]
    sys.stdout.reconfigure(encoding="utf-8")
    print(
        f"wrote {args.output} (catalogVersion {catalog['catalogVersion']}, "
        f"{len(catalog['categories'])} categories / {len(active)} issues)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
