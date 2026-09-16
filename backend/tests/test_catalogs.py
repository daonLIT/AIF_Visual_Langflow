import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND / "scripts"))

from import_issue_catalog import CatalogImportError, build_catalog  # noqa: E402

from app.services.catalogs import CatalogError, IssueCatalog, SchemeCatalog  # noqa: E402

HEADER = ["상위 쟁점군", "세부 쟁점", "비교·판단 기준"]


def write_xlsx(path: Path, rows: list[list[str]], merged: str | None = None) -> None:
    """공유 문자열을 쓰는 최소 xlsx (엑셀이 저장하는 형식과 같은 구조)."""
    strings: list[str] = []
    index: dict[str, int] = {}
    sheet_rows = []
    for r, row in enumerate(rows, start=1):
        cells = []
        for c, value in enumerate(row):
            if value not in index:
                index[value] = len(strings)
                strings.append(value)
            cells.append(f'<c r="{"ABC"[c]}{r}" t="s"><v>{index[value]}</v></c>')
        sheet_rows.append(f'<row r="{r}">{"".join(cells)}</row>')
    ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
    merge_xml = f'<mergeCells count="1"><mergeCell ref="{merged}"/></mergeCells>' if merged else ""
    with zipfile.ZipFile(path, "w") as archive:
        archive.writestr(
            "xl/workbook.xml",
            f'<workbook {ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
        )
        archive.writestr(
            "xl/_rels/workbook.xml.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
        )
        archive.writestr(
            "xl/sharedStrings.xml",
            f'<sst {ns}>' + "".join(f"<si><t>{escape(s)}</t></si>" for s in strings) + "</sst>",
        )
        archive.writestr("xl/worksheets/sheet1.xml", f'<worksheet {ns}><sheetData>{"".join(sheet_rows)}</sheetData>{merge_xml}</worksheet>')


class CatalogImportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def xlsx(self, rows, name="c.xlsx", merged=None):
        path = self.dir / name
        write_xlsx(path, [HEADER, *rows], merged)
        return path

    def test_preserves_strings_and_assigns_ids(self):
        rows = [["군 A", "항목 1", "기준 · 원문 그대로  (공백 포함)"], ["군 A", "항목 2", "기준2"], ["군 B", "항목 1", "기준3"]]
        catalog = build_catalog(self.xlsx(rows))
        self.assertEqual(catalog["catalogVersion"], 1)
        self.assertEqual([c["categoryId"] for c in catalog["categories"]], ["CAT-01", "CAT-02"])
        self.assertEqual([i["issueId"] for i in catalog["issues"]], ["ISS-001", "ISS-002", "ISS-003"])
        self.assertEqual(catalog["issues"][0]["criteria"], "기준 · 원문 그대로  (공백 포함)")
        self.assertEqual(catalog["issues"][2]["sourceRow"], 4)
        self.assertEqual(len(catalog["source"]["sha256"]), 64)

    def test_reorder_keeps_ids_and_version(self):
        rows = [["군 A", "항목 1", "기준1"], ["군 A", "항목 2", "기준2"]]
        first = build_catalog(self.xlsx(rows))
        second = build_catalog(self.xlsx(list(reversed(rows)), name="d.xlsx"), previous=first)
        ids = {i["label"]: i["issueId"] for i in second["issues"]}
        self.assertEqual(ids, {"항목 1": "ISS-001", "항목 2": "ISS-002"})
        # 순서만 바뀌면 내용 변경이 아니므로 버전을 올리지 않는다.
        self.assertEqual(second["catalogVersion"], 1)

    def test_new_changed_and_retired_items(self):
        first = build_catalog(self.xlsx([["군 A", "항목 1", "기준1"], ["군 A", "항목 2", "기준2"]]))
        second = build_catalog(
            self.xlsx([["군 A", "항목 1", "기준1 수정"], ["군 A", "항목 3", "기준3"]], name="e.xlsx"), previous=first
        )
        by_label = {i["label"]: i for i in second["issues"]}
        self.assertEqual(by_label["항목 1"]["issueId"], "ISS-001")
        self.assertEqual(by_label["항목 3"]["issueId"], "ISS-003")
        self.assertTrue(by_label["항목 2"]["retired"])
        self.assertEqual(second["catalogVersion"], 2)

    def test_rename_inherits_id(self):
        first = build_catalog(self.xlsx([["군 A", "항목 1", "기준1"]]))
        second = build_catalog(
            self.xlsx([["군 A", "항목 일", "기준1"]], name="f.xlsx"),
            previous=first,
            renames={"군 A␟항목 1": "군 A␟항목 일"},
        )
        active = [i for i in second["issues"] if not i.get("retired")]
        self.assertEqual(active[0]["issueId"], "ISS-001")

    def test_rejects_bad_header_duplicates_and_merges(self):
        path = self.dir / "bad.xlsx"
        write_xlsx(path, [["a", "b", "c"], ["군", "항목", "기준"]])
        with self.assertRaises(CatalogImportError):
            build_catalog(path)
        with self.assertRaises(CatalogImportError):
            build_catalog(self.xlsx([["군 A", "항목 1", "x"], ["군 A", "항목 1", "y"]], name="dup.xlsx"))
        with self.assertRaises(CatalogImportError):
            build_catalog(self.xlsx([["군 A", "항목 1", "x"]], name="m.xlsx", merged="A2:A3"))

    def test_repository_catalog_matches_source_counts(self):
        catalog = json.loads((BACKEND / "catalog" / "issue_catalog.json").read_text(encoding="utf-8"))
        active = [i for i in catalog["issues"] if not i.get("retired")]
        self.assertEqual(len(catalog["categories"]), 8)
        self.assertEqual(len(active), 52)
        self.assertEqual(catalog["source"]["range"], "A1:C53")
        self.assertEqual(len({i["issueId"] for i in active}), 52)


class CatalogServiceTest(unittest.TestCase):
    def setUp(self):
        self.issues = IssueCatalog.load(BACKEND / "catalog" / "issue_catalog.json")
        self.schemes = SchemeCatalog.load(BACKEND / "catalog" / "walton_schemes.json")

    def test_issue_input_items_keep_all_52(self):
        items = self.issues.input_items()
        self.assertEqual(len(items), 52)
        self.assertEqual(set(items[0]), {"issueId", "categoryName", "label", "criteria"})
        self.assertTrue(self.issues.is_active("ISS-001"))
        self.assertFalse(self.issues.is_active("ISS-999"))
        self.assertEqual(len(self.issues.sha256), 64)

    def test_scheme_catalog_is_the_user_selected_ten(self):
        walton = [s["name"] for s in self.schemes.data["schemes"] if s["group"] != "쟁점 구조"]
        self.assertEqual(
            sorted(walton),
            sorted([
                "Argument from Witness Testimony", "Argument from Evidence to a Hypothesis", "Argument from Sign",
                "Argument from Inconsistent Commitment", "Argument from Alternatives", "Argument from Effect to Cause",
                "Argument from Best Explanation", "Argument from Ignorance", "Argument from Verbal Classification",
                "Argument from an Established Rule",
            ]),
        )
        self.assertEqual(self.schemes.version, 3)
        for scheme in self.schemes.data["schemes"]:
            self.assertIn(scheme["verification"], self.schemes.data["verificationLabels"], scheme["schemeKey"])
            self.assertTrue(scheme["sourceNote"] and scheme["criticalQuestions"], scheme["schemeKey"])

    def test_issue_relation_schemes_are_project_defined(self):
        """쟁점 구조 관계 scheme 2개. Walton 목록이 아니므로 출처 대조 대상이 아니고, 외부 ID 도 없다."""
        structural = {s["schemeKey"]: s for s in self.schemes.data["schemes"] if s["group"] == "쟁점 구조"}
        self.assertEqual(set(structural), {"issue_resolution", "issue_aggregation"})
        for key, scheme in structural.items():
            self.assertEqual(scheme["verification"], "project-defined", key)
            self.assertIsNone(scheme["aifdbSchemeId"], key)
            self.assertTrue(scheme["premiseRoles"] and scheme["conclusionRole"], key)
        self.assertEqual(self.schemes.roles("issue_resolution"), {"finding"})
        self.assertEqual(self.schemes.roles("issue_aggregation"), {"issueFinding"})

    def test_scheme_migrations_cover_all_v2_keys(self):
        # 대응표는 카탈로그와 함께 읽히며 검사를 통과해야 한다 (load 에서 CatalogError 가 나지 않음).
        [migration] = self.schemes.migrations
        self.assertEqual((migration["fromVersion"], migration["toVersion"]), (2, 3))
        v2_keys = {
            "witness_testimony", "expert_opinion", "position_to_know", "perception", "sign", "evidence_to_hypothesis",
            "abduction", "cause_to_effect", "correlation_to_cause", "established_rule", "verbal_classification",
            "analogy", "lack_of_evidence", "inconsistent_commitment", "bias", "credibility_assessment", "convergent_facts",
        }
        self.assertEqual(set(migration["schemes"]), v2_keys)
        rules = migration["schemes"]
        self.assertEqual((rules["lack_of_evidence"]["action"], rules["lack_of_evidence"]["to"]), ("replace", "ignorance"))
        self.assertEqual((rules["abduction"]["action"], rules["abduction"]["to"]), ("replace", "best_explanation"))
        self.assertEqual(rules["convergent_facts"].get("candidates"), None)
        self.assertEqual(self.schemes.public_data()["migrations"], self.schemes.migrations)

    def test_scheme_migrations_reject_unknown_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            (folder / "walton_schemes.json").write_bytes((BACKEND / "catalog" / "walton_schemes.json").read_bytes())
            bad = {
                "migrations": [
                    {
                        "fromVersion": 2,
                        "toVersion": 3,
                        "schemes": {
                            "lack_of_evidence": {"action": "replace", "to": "ignorance", "roleMap": {"absence": "missing"}},
                            "position_to_know": {"action": "unclassify", "candidates": [{"schemeKey": "expert_opinion"}]},
                            "sign": {"action": "unclassify"},
                        },
                    }
                ]
            }
            (folder / "scheme_catalog_migrations.json").write_text(json.dumps(bad), encoding="utf-8")
            with self.assertRaises(CatalogError) as caught:
                SchemeCatalog.load(folder / "walton_schemes.json")
            message = str(caught.exception)
            self.assertIn("ignorance 에 없는 역할", message)
            self.assertIn("expert_opinion", message)
            self.assertIn("sign: 현재 카탈로그에 있는 key 는 keep", message)

    def test_scheme_catalog_shape(self):
        self.assertEqual(self.schemes.data["status"], "draft")
        self.assertIn("witness_testimony", self.schemes.by_key)
        self.assertTrue(self.schemes.is_valid_key("unclassified"))
        self.assertTrue(self.schemes.is_valid_key("custom"))
        self.assertFalse(self.schemes.is_valid_key("other"))
        for scheme in self.schemes.data["schemes"]:
            self.assertTrue(scheme["nameKo"] and scheme["name"], scheme["schemeKey"])
            roles = [p["roleId"] for p in scheme["premiseRoles"]]
            self.assertEqual(len(roles), len(set(roles)), scheme["schemeKey"])
            ids = [q["id"] for q in scheme["criticalQuestions"]]
            self.assertEqual(len(ids), len(set(ids)), scheme["schemeKey"])
            # 검증된 외부 ID 대응이 없으면 비워 둔다(숫자 ID 를 추측하지 않음).
            self.assertIsNone(scheme["aifdbSchemeId"])


if __name__ == "__main__":
    unittest.main()
