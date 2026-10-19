"""근무표 엑셀 내보내기 (POST /api/schedules/export.xlsx) — 병동 번표 모양 · 다시 올리기 왕복.

그 달에 걸친 주 전부(11월 → 11/1~12/5)를 담고, 계는 수식이 아니라 값이다 — 이 파일을 다시 올리면
_parse_xlsx_sheets(data_only)가 읽으므로 수식 칸은 비고 'D·근무자수' 줄이 이름으로 뜬다 (결정 1-44 ②).
DB를 건드리지 않는 엔드포인트라 프로필 픽스처 불필요.
"""
from __future__ import annotations

import datetime
import io
from datetime import date, timedelta

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient")
openpyxl = pytest.importorskip("openpyxl")

from server.api import _parse_xlsx_sheets, app  # noqa: E402

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
DAYS = [(date(2026, 11, 1) + timedelta(i)).isoformat() for i in range(35)]   # 11/1(일) ~ 12/5(토)
ROWS = [
    ["간호01", *(["D", "E", "N", "N", "OF", "OF", "주"] * 5)],
    ["간호02", "/D", "/E"],                                   # 신규 — 짧은 줄은 빈칸으로 채운다
    ["간호03", "중", "법", "생", "V", "D1", *(["D"] * 30)],
    ["=간호04", *(["D"] * 35)],                               # '=' 로 시작해도 수식이 아니라 글자
]
BODY = {"year": 2026, "month": 11, "title": "2026년 11월 101병동 근무표", "days": DAYS,
        "holidays": ["2026-11-03"], "rows": ROWS}
TOTALS = ["D", "E", "N", "중", "OF", "법", "생", "V", "주", "근무"]


@pytest.fixture(scope="module")
def client():
    return fastapi_testclient.TestClient(app)


@pytest.fixture(scope="module")
def res(client):
    return client.post("/api/schedules/export.xlsx", json=BODY)


def _row(ws, r, c1, c2):
    return [ws.cell(r, c).value for c in range(c1, c2 + 1)]


def test_layout(res):
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == XLSX
    assert res.headers["content-disposition"] == 'attachment; filename="schedule.xlsx"'
    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    assert wb.sheetnames == ["11월"]
    ws = wb["11월"]
    # 1줄 제목 (A~계 끝 병합) · 2줄 주기 (7칸씩) + '11월 계' — 날짜 B~AJ, 계 AK~AT
    assert ws["A1"].value == "2026년 11월 101병동 근무표 (11월 1일~12월 5일)"
    merged = {str(r) for r in ws.merged_cells.ranges}
    assert {"A1:AT1", "B2:H2", "I2:O2", "AD2:AJ2", "AK2:AT2"} <= merged
    assert [ws[c].value for c in ("B2", "I2", "P2", "W2", "AD2", "AK2")] == ["4주기", "1주기", "2주기", "3주기", "4주기", "11월 계"]
    # 3줄 진짜 날짜 · 4줄 이름 + 요일 + 계 이름
    assert ws["B3"].value == datetime.datetime(2026, 11, 1) and ws["B3"].number_format == 'm"/"d'
    assert ws["AJ3"].value == datetime.datetime(2026, 12, 5)
    assert ws["A4"].value == "이름" and _row(ws, 4, 2, 8) == list("일월화수목금토")
    assert _row(ws, 4, 37, 46) == TOTALS
    # 일요일·공휴일 빨강, 앞뒤 달 칸 회색, 일요일 왼쪽 굵은 선
    red = "FFFF0000"
    assert ws["B3"].font.color.rgb == red and ws["B4"].font.color.rgb == red    # 11/1 일
    assert ws["D3"].font.color.rgb == red and ws["D4"].font.color.rgb == red    # 11/3 공휴일
    assert ws["C3"].font.color is None
    assert ws["AF3"].fill.fgColor.rgb == "FFEDEDED" and ws["AF4"].fill.fgColor.rgb == "FFEDEDED"   # 12/1
    assert ws["AE3"].fill.fill_type is None                                      # 11/30
    assert ws["B5"].border.left.style == "medium" and ws["I9"].border.left.style == "medium"
    assert ws["C5"].border.left.style is None
    # 사람 줄 + 그 달 계 (11월 칸만 — 12/1~12/5 는 세지 않는다, 신규 '/D' 는 자기 줄에서 D)
    assert _row(ws, 5, 1, 36) == ROWS[0]
    assert _row(ws, 5, 37, 46) == [5, 5, 8, 0, 8, 0, 0, 0, 4, 18]
    assert _row(ws, 6, 37, 46) == [1, 1, 0, 0, 0, 0, 0, 0, 0, 2]
    assert _row(ws, 7, 37, 46) == [25, 0, 0, 1, 0, 1, 1, 1, 0, 27]               # 근무 = D + 중 + D1
    assert _row(ws, 8, 37, 46) == [30, 0, 0, 0, 0, 0, 0, 0, 0, 30]
    assert ws["A8"].value == "=간호04" and ws["A8"].data_type == "s"
    # 날마다 인원 — 신규 '/D' 와 D1 은 세지 않는다 (병동 번표 아래 줄)
    assert [ws.cell(r, 1).value for r in range(9, 14)] == ["D", "E", "N", "중", "근무자수"]
    assert _row(ws, 9, 2, 6) == [2, 1, 1, 1, 1]
    assert _row(ws, 13, 2, 6) == [3, 2, 2, 2, 1]
    assert all(isinstance(v, int) for r in range(9, 14) for v in _row(ws, r, 2, 36))
    # 수식은 한 칸도 없다
    assert not [c.coordinate for row in ws.iter_rows() for c in row if c.data_type == "f"]
    assert ws.freeze_panes == "B5"
    assert ws.page_setup.orientation == "landscape" and int(ws.page_setup.paperSize) == 9
    assert ws.sheet_properties.pageSetUpPr.fitToPage and int(ws.page_setup.fitToHeight) == 0


def test_reads_back_through_importer(res):
    """다시 올리기(근무표 파일 올리기 · 파일에서 읽기)가 쓰는 파서로 읽으면 그대로 돌아온다."""
    g = _parse_xlsx_sheets(res.content)[0]["rows"]
    assert g[2][1:36] == DAYS                              # 날짜 줄 = ISO — 클라이언트가 년월까지 안다
    assert g[3][:8] == ["이름", *"일월화수목금토"]
    for k, row in enumerate(ROWS):
        assert g[4 + k][:36] == (row + [""] * 36)[:36]       # '/D' · 빈칸 · '=간호04' 그대로
    assert [r[0] for r in g[8:13]] == ["D", "E", "N", "중", "근무자수"]
    # 날짜 칸이 모두 숫자 → 붙여넣기 매칭이 사람 줄이 아니라고 보고 건너뛴다 (paste-import.js _matchGrid)
    assert all(c.isdigit() for r in g[8:13] for c in r[1:36])
    assert len(g) == 13


def test_december_crosses_year(client):
    days = [(date(2026, 11, 29) + timedelta(i)).isoformat() for i in range(35)]   # 11/29 ~ 1/2
    r = client.post("/api/schedules/export.xlsx", json={
        "year": 2026, "month": 12, "days": days, "rows": [["간호01", *(["N"] * 35)]]})
    assert r.status_code == 200, r.text
    ws = openpyxl.load_workbook(io.BytesIO(r.content))["12월"]
    assert ws["A1"].value == "2026년 12월 근무표 (11월 29일~1월 2일)"
    assert ws["B3"].fill.fgColor.rgb == "FFEDEDED" and ws["D3"].fill.fill_type is None   # 11/29 회색 · 12/1
    assert ws["AK2"].value == "12월 계"
    assert ws["AM5"].value == 31 and ws["AT5"].value == 31                               # N · 근무 — 12월 칸만 31일


@pytest.mark.parametrize("body", [
    {**BODY, "days": ["2026-13-01"]},
    {**BODY, "days": []},
    {**BODY, "month": 0},
    {k: v for k, v in BODY.items() if k != "rows"},
    {**BODY, "rows": [[]]},
    {**BODY, "year": "올해"},
])
def test_bad_input_400(client, body):
    r = client.post("/api/schedules/export.xlsx", json=body)
    assert r.status_code == 400
    assert r.json()["detail"].startswith("근무표 형식이 맞지 않습니다")
