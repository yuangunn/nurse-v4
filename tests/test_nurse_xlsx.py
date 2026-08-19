"""간호사 명부 xlsx 왕복 (M3) — 템플릿/내보내기/가져오기 회귀.

DB가 필요한 케이스는 APPDATA를 tmp로 돌려 시드 DB를 쓴다.
"""
from __future__ import annotations

import base64
import datetime
import io

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")
openpyxl = pytest.importorskip("openpyxl")


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    from server import database as db
    from server.api import app

    db.init_db()
    return fastapi_testclient.TestClient(app)


HEADER = [
    "id", "이름", "그룹", "성별", "가능근무",
    "야간전담", "시니어리티", "주휴요일", "주휴로테이션",
    "트레이닝", "트레이닝종료일", "프리셉터ID",
    "전입일", "전출일",
]


def test_template_xlsx(client):
    res = client.get("/api/nurses/template.xlsx")
    assert res.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    assert wb.sheetnames == ["간호사 명부", "작성 방법"]
    ws = wb["간호사 명부"]
    assert [c.value for c in ws[1]] == HEADER
    # 예시 행 + 드롭다운(성별/야간전담/주휴요일/주휴로테이션/트레이닝)
    assert ws.max_row >= 5
    assert len(ws.data_validations.dataValidation) == 5


def test_export_xlsx_roundtrip_format(client):
    res = client.get("/api/nurses/export.xlsx")
    assert res.status_code == 200
    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    ws = wb["간호사 명부"]
    assert [c.value for c in ws[1]] == HEADER
    assert ws.max_row >= 2  # 시드 간호사 포함


def _roster_xlsx(rows, guide_first=True) -> str:
    wb = openpyxl.Workbook()
    ws0 = wb.active
    if guide_first:
        ws0.title = "작성 방법"
        ws0.append(["안내 텍스트"])
        ws = wb.create_sheet("간호사 명부")
    else:
        ws = ws0
    ws.append(HEADER)
    for r in rows:
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return base64.b64encode(buf.getvalue()).decode()


def test_import_xlsx_preview_and_apply(client):
    # 안내 시트가 앞에 있어도 '이름' 헤더가 있는 시트를 골라야 한다.
    # 성별 '여', 날짜는 엑셀 날짜 셀(datetime) — ISO로 정규화돼 저장돼야 한다.
    b64 = _roster_xlsx([
        ["x001", "황엑셀", "D", "여", "D,E,N", "N", 7, "목", "Y", "N", "", "",
         datetime.datetime(2026, 4, 1), ""],
        ["", "김시트", "D", "male", "DC,D", "Y", 8, "", "N", "N", "", "", "", ""],
    ])
    prev = client.post("/api/nurses/import/preview", json={"csv_b64": b64})
    assert prev.status_code == 200, prev.text
    body = prev.json()
    assert body["parsed_count"] == 2
    assert {a["name"] for a in body["will_add"]} == {"황엑셀", "김시트"}
    assert body["errors"] == []

    res = client.post("/api/nurses/import", json={"csv_b64": b64})
    assert res.status_code == 200, res.text
    nurses = {n["name"]: n for n in client.get("/api/nurses").json()}
    hw = nurses["황엑셀"]
    assert hw["gender"] == "female"          # '여' → female
    assert hw["start_date"] == "2026-04-01"  # 날짜 셀 → ISO
    assert hw["juhu_day"] == 4               # 목
    assert nurses["김시트"]["is_night_shift"] is True


def test_import_csv_still_works(client):
    # 기존 CSV 경로(cp949 포함) 회귀 — rows 기반 리팩토링 후에도 동일 동작
    text = "이름,그룹,성별\n최씨에스브이,C,남\n"
    b64 = base64.b64encode(text.encode("cp949")).decode()
    prev = client.post("/api/nurses/import/preview", json={"csv_b64": b64})
    assert prev.status_code == 200, prev.text
    body = prev.json()
    assert body["parsed_count"] == 1
    assert body["will_add"][0]["name"] == "최씨에스브이"


def test_import_comment_rows_ignored(client):
    text = "# 안내 주석\n이름,그룹\n박주석,B\n"
    b64 = base64.b64encode(text.encode("utf-8-sig")).decode()
    prev = client.post("/api/nurses/import/preview", json={"csv_b64": b64})
    assert prev.status_code == 200
    assert prev.json()["parsed_count"] == 1
