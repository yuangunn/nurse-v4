"""/api/parse-table-file — 표 파일 파싱 엔드포인트 회귀.

xlsx(병합 셀·날짜 셀 ISO 변환)와 CSV(CP949 폴백·구분자 감지)가
클라이언트 붙여넣기 파이프라인이 기대하는 2D 문자열 그리드로 나오는지 검증.
DB를 건드리지 않는 엔드포인트라 프로필 픽스처 불필요.
"""
from __future__ import annotations

import base64
import datetime
import io

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")
openpyxl = pytest.importorskip("openpyxl")

from server.api import app  # noqa: E402


@pytest.fixture(scope="module")
def client():
    return fastapi_testclient.TestClient(app)


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def _make_xlsx() -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "근무표"
    # 헤더: A1 이름 + 날짜 셀(datetime — 엑셀 날짜 서식) + 문자 날짜
    ws["A1"] = "이름"
    ws["B1"] = datetime.datetime(2026, 5, 26)
    ws["C1"] = datetime.date(2026, 5, 27)
    ws["D1"] = "6/1"
    ws["A2"] = "김지현"
    ws["B2"] = "D"
    ws["C2"] = "E"
    ws["D2"] = "OF"
    # 병합 셀: A4:B4 에 값 하나 — 좌상단 값이 범위 전체로 전파돼야 한다
    ws["A4"] = "박서연"
    ws.merge_cells("A4:B4")
    ws["C4"] = "N"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_xlsx_dates_and_merge(client):
    res = client.post(
        "/api/parse-table-file",
        json={"file_b64": _b64(_make_xlsx()), "filename": "표.xlsx"},
    )
    assert res.status_code == 200, res.text
    sheets = res.json()["sheets"]
    assert [s["name"] for s in sheets] == ["근무표"]
    rows = sheets[0]["rows"]
    # 날짜 셀은 ISO로 — 클라이언트가 월·연도까지 해석
    assert rows[0][:4] == ["이름", "2026-05-26", "2026-05-27", "6/1"]
    assert rows[1][:4] == ["김지현", "D", "E", "OF"]
    # 병합 전파: A4 값이 B4에도
    assert rows[3][0] == "박서연" and rows[3][1] == "박서연"


def test_csv_cp949_and_tab(client):
    text = "이름\t5/26\t5/27\n김지현\tD\tE\n"
    res = client.post(
        "/api/parse-table-file",
        json={"file_b64": _b64(text.encode("cp949")), "filename": "표.csv"},
    )
    assert res.status_code == 200, res.text
    rows = res.json()["sheets"][0]["rows"]
    assert rows == [["이름", "5/26", "5/27"], ["김지현", "D", "E"]]


def test_csv_comma(client):
    text = "이름,1,2\n김지현,D,\"E\"\n"
    res = client.post(
        "/api/parse-table-file",
        json={"file_b64": _b64(text.encode("utf-8-sig")), "filename": "표.csv"},
    )
    assert res.status_code == 200, res.text
    rows = res.json()["sheets"][0]["rows"]
    assert rows == [["이름", "1", "2"], ["김지현", "D", "E"]]


def test_xls_rejected(client):
    res = client.post(
        "/api/parse-table-file",
        json={"file_b64": _b64(b"whatever"), "filename": "old.xls"},
    )
    assert res.status_code == 400
    assert "xlsx" in res.json()["detail"]


def test_unknown_ext_rejected(client):
    res = client.post(
        "/api/parse-table-file",
        json={"file_b64": _b64(b"x"), "filename": "a.pdf"},
    )
    assert res.status_code == 400


def test_missing_body(client):
    res = client.post("/api/parse-table-file", json={"filename": "a.xlsx"})
    assert res.status_code == 400
