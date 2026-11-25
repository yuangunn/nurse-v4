"""근무표 엑셀 내보내기 (POST /api/schedules/export.xlsx) — 병동 번표 양식 · 다시 올리기 왕복.

계는 양식과 같은 수식(COUNTIF·SUM)이고, 수식마다 계산해 둔 값이 함께 들어 있다 — 이 파일을 다시 올리면
_parse_xlsx_sheets(data_only)가 읽으므로 값이 없으면 'D·근무자수' 줄이 이름으로 뜬다 (결정 1-44 ②).
DB를 건드리지 않는 엔드포인트라 프로필 픽스처 불필요.
"""
from __future__ import annotations

import datetime
import io
import re
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
        "holidays": ["2026-11-03"], "rows": ROWS,
        "teams": ["A", "A", "B", ""], "team_colors": {"A": "#DDEBF7", "B": "#1f3864", "C": "빨강"},
        "marks": ["wr k", "", "k" * 35],                     # 짧거나 없는 줄은 빈 표식
        "charge": ["DEN", "", "DN", "D"], "notes": [[0, 2, "개인 사정"], [9, 0, "없는 줄"]]}
TOTALS = ["D", "E", "N", "중", "OF", "법", "생", "V", "주", "총근무"]


@pytest.fixture(scope="module")
def client():
    return fastapi_testclient.TestClient(app)


@pytest.fixture(scope="module")
def res(client):
    return client.post("/api/schedules/export.xlsx", json=BODY)


def _row(ws, r, c1, c2):
    return [ws.cell(r, c).value for c in range(c1, c2 + 1)]


def _calc(ws, v):
    """양식 수식만 푸는 작은 계산기 — COUNTIF(범위,"글자")·SUM(범위)를 '+' 로 이은 것과, 앞 달 시트의 칸을 가리키는 IF.
    COUNTIF 는 칸 전체·대소문자 무시. 범위 안의 수식 칸도 풀어서 센다."""
    if not (isinstance(v, str) and v.startswith("=")):
        return v
    ref = re.fullmatch(r"""=IF\('([^']+)'!([A-Z]+\d+)="","",'\1'!\2\)""", v)
    if ref:
        return ws.parent[ref.group(1)][ref.group(2)].value or ""
    # 강조의 숨긴 계산 칸 — '여기까지 며칠째'(같은 근무 · 연속 근무). 글자 비교는 엑셀처럼 대소문자를 가리지 않는다
    txt = lambda c: str(_calc(ws, ws[c].value) or "").upper()   # noqa: E731
    run = re.fullmatch(r'=IF\(OR\(((?:[A-Z]+\d+="[^"]+",?)+)\),(?:IF\(([A-Z]+\d+)=([A-Z]+\d+),([A-Z]+\d+)\+1,1\)|([A-Z]+\d+)\+1),0\)', v)
    if run:
        cell, kinds = re.match(r"[A-Z]+\d+", run.group(1)).group(0), re.findall(r'="([^"]+)"', run.group(1))
        if txt(cell) not in kinds:
            return 0
        if run.group(5):
            return (_calc(ws, ws[run.group(5)].value) or 0) + 1
        return (_calc(ws, ws[run.group(4)].value) or 0) + 1 if txt(run.group(2)) == txt(run.group(3)) else 1
    total = 0
    for fn, rng, arg in re.findall(r'(COUNTIF|SUM)\(([A-Z$]+\d+:[A-Z$]+\d+)(?:,"([^"]*)")?\)', v):
        got = [_calc(ws, c.value) for row in ws[rng.replace("$", "")] for c in row]
        total += sum(str(x or "").upper() == arg.upper() for x in got) if fn == "COUNTIF" else sum(x or 0 for x in got)
    return total


def test_layout(res):
    assert res.status_code == 200, res.text
    assert res.headers["content-type"] == XLSX
    assert res.headers["content-disposition"] == 'attachment; filename="schedule.xlsx"'
    wb = openpyxl.load_workbook(io.BytesIO(res.content))
    assert wb.sheetnames == ["11월"]
    assert wb._fonts[0].name == "맑은 고딕"                  # 기본 글꼴 — 열 너비 단위가 이 글꼴의 숫자 폭
    ws = wb["11월"]
    # 1줄 제목 (A~날짜 끝 병합) · 2줄 주기 (7칸씩) — 날짜 B~AJ, 계 AK~AT
    assert ws["A1"].value == "2026년 11월 101병동 근무표 (11월 1일~12월 5일)"
    assert {str(r) for r in ws.merged_cells.ranges} == {"A1:AJ1", "B2:H2", "I2:O2", "P2:V2", "W2:AC2", "AD2:AJ2",
                                                           "AK1:AL1", "AM1:AT1"}   # 제목 줄 오른쪽 — '강조' 이름표 + 고르는 칸 (결정 1-105)
    assert [ws[c].value for c in ("B2", "I2", "P2", "W2", "AD2")] == ["4주기", "1주기", "2주기", "3주기", "4주기"]
    # 3줄 진짜 날짜 · 4줄 이름 + 요일 + 계 이름
    assert ws["B3"].value == datetime.datetime(2026, 11, 1) and ws["B3"].number_format == 'm"/"d'
    assert ws["AJ3"].value == datetime.datetime(2026, 12, 5)
    assert ws["A4"].value == "이름" and _row(ws, 4, 2, 8) == list("일월화수목금토")
    assert _row(ws, 4, 37, 46) == TOTALS
    # 일요일·공휴일 빨강
    red = "FFFF0000"
    assert ws["B3"].font.color.rgb == red and ws["B4"].font.color.rgb == red    # 11/1 일
    assert ws["D3"].font.color.rgb == red and ws["D4"].font.color.rgb == red    # 11/3 공휴일
    assert ws["C3"].font.color is None
    # 양식 치수 · 글꼴
    assert ws.row_dimensions[1].height == 17.25 and ws.row_dimensions[16].height == 17.25
    assert [ws.column_dimensions[c].width for c in ("A", "B", "AJ", "AK", "AT")] == [7.88, 3.75, 3.75, 3.62, 3.62]
    assert ws["B3"].alignment.shrink_to_fit                  # 날짜가 좁은 칸에서 #### 로 바뀌지 않는다
    assert (ws["A5"].font.name, ws["A5"].font.sz, ws["A5"].font.b) == ("맑은 고딕", 10, True)
    assert (ws["B5"].font.sz, ws["B3"].font.sz, ws["AK5"].font.name, ws["AT4"].font.sz) == (9, 8, "Calibri", 6)
    # 사람 줄
    assert _row(ws, 5, 1, 36) == ROWS[0]
    assert ws["A8"].value == "=간호04" and ws["A8"].data_type == "s"
    assert [ws.cell(r, 1).value for r in range(9, 17)] == ["D", "E", "N", "중", "근무자수", "D차지", "E차지", "N차지"]
    assert ws.freeze_panes == "B5"
    assert ws.page_setup.orientation == "landscape" and int(ws.page_setup.paperSize) == 9
    assert ws.sheet_properties.pageSetUpPr.fitToPage and int(ws.page_setup.fitToHeight) == 0


def test_colors_and_lines(res):
    ws = openpyxl.load_workbook(io.BytesIO(res.content))["11월"]
    fill = lambda c: ws[c].fill.fgColor.rgb if ws[c].fill.fill_type else None   # noqa: E731
    # 이름 칸 = 팀 색 (어두운 색이면 흰 글씨) · 색이 없는 팀·잘못된 색은 그대로
    assert [fill(c) for c in ("A5", "A6", "A7", "A8")] == ["FFDDEBF7", "FFDDEBF7", "FF1F3864", None]
    assert ws["A5"].font.color is None and ws["A7"].font.color.rgb == "FFFFFFFF"
    # 칸 표식 — w 원티드 분홍 · r 풀린 칸 파랑 바탕 흰 글씨 · k 나이트킵 노랑 (이름 칸은 팀 색 그대로)
    assert [fill(c) for c in ("B5", "C5", "D5", "E5", "F5", "B6")] == ["FFFF99FF", "FF0070C0", None, "FFFFFF00", None, None]
    assert ws["C5"].font.color.rgb == "FFFFFFFF" and ws["B5"].font.color is None
    assert fill("B7") == "FFFFFF00" and fill("AJ7") == "FFFFFF00"
    # 계의 N 열 · 아래 N 줄은 노랑, 중 줄 이름은 하늘색
    assert [fill(c) for c in ("AM4", "AM5", "AK5", "A11", "B11", "A12", "B12")] == \
        ["FFFFFF00", "FFFFFF00", None, "FFFFFF00", "FFFFFF00", "FF42C7F1", None]
    assert [fill(c) for c in ("AN4", "AN5", "AQ4", "AR5", "AO5")] == ["FF00B0F0", "FF00B0F0", "FFA9D08E", "FFA9D08E", None]   # 중·생·V 열
    # 메모 — 명부 밖 줄은 버린다
    assert ws["D5"].comment.text == "개인 사정"
    assert sum(1 for row in ws.iter_rows() for c in row if c.comment) == 1
    # 굵은 선 — 바깥 · 일요일 왼쪽 · 팀이 바뀌는 줄 위 · 사람 줄 아래 · 인원 줄 사이. 안쪽은 가는 선
    bd = lambda c: "".join((getattr(ws[c].border, s).style or "-")[0] for s in ("left", "right", "top", "bottom"))   # noqa: E731
    assert bd("B5") == "mtmt" and bd("C5") == "ttmt" and bd("H5") == "tmmt"      # 11/1 일 · 월 · 토(다음이 일)
    assert bd("A6") == "mmtm" and bd("A7") == "mmmm"                             # A → B → 팀 없음
    assert bd("C6") == "tttm" and bd("C9") == "ttmm" and bd("C13") == "ttmm"     # 팀 끝 줄 · D 줄 · 근무자수 줄
    assert bd("C14") == "ttmt" and bd("C16") == "tttm"                           # 차지 세 줄은 한 덩어리
    assert bd("AK5") == "mmmt" and bd("AT8") == "mmmm" and bd("AT6") == "mmtm" and ws["AK9"].border.left.style is None
    assert bd("A2") == "mmm-" and bd("A3") == "mm--" and bd("A4") == "mm-m"      # 이름 머리 칸은 세 줄이 한 칸
    assert bd("AJ16") == "tmtm"


def test_formulas_match_cached_values(res):
    """수식 칸마다 든 값이 수식을 푼 값과 같다 — 다시 올리기·미리보기는 이 값을 읽는다."""
    ws = openpyxl.load_workbook(io.BytesIO(res.content))["11월"]
    wv = openpyxl.load_workbook(io.BytesIO(res.content), data_only=True)["11월"]
    fx = [c for row in ws.iter_rows() for c in row if c.data_type == "f"]
    assert len(fx) == 4 * 10 + 8 * 35 + 2 * 4 * 35            # 사람 줄 계 + 아래 여덟 줄 + 강조의 숨긴 계산 칸 두 묶음
    assert [c.coordinate for c in fx if wv[c.coordinate].value != _calc(ws, c.value)] == []
    # 오른쪽 계 — 모두 그 달(11/1~11/30 = B~AE) 칸만 (12/1~12/5 는 12월 표가 센다), 총근무 = D+E+N+중
    assert _row(ws, 5, 37, 46) == [f'=COUNTIF(B5:AE5,"{t}")' for t in TOTALS[:-1]] + ["=SUM(AK5:AN5)"]
    assert _row(wv, 5, 37, 46) == [5, 5, 8, 0, 8, 0, 0, 0, 4, 18]
    assert _row(wv, 6, 37, 46) == [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]                  # 신규 '/D'·'/E' 는 D·E 가 아니다
    assert _row(wv, 7, 37, 46) == [25, 0, 0, 1, 0, 1, 1, 1, 0, 26]                # D1 은 세지 않는다
    # 아래 — 날마다 인원 · 근무자수 · 차지 가능한 줄에서 센 D·E·N (떨어진 줄은 구간마다 더한다)
    assert ws["B9"].value == '=COUNTIF(B$5:B$8,"D")' and ws["B13"].value == "=SUM(B9:B12)"
    assert ws["B14"].value == '=COUNTIF(B5:B5,"D")+COUNTIF(B7:B8,"D")'
    assert ws["B15"].value == '=COUNTIF(B5:B5,"E")' and ws["B16"].value == '=COUNTIF(B5:B5,"N")+COUNTIF(B7:B7,"N")'
    assert _row(wv, 9, 2, 6) == [2, 1, 1, 1, 1] and _row(wv, 13, 2, 6) == [3, 2, 2, 2, 1]
    assert _row(wv, 14, 2, 4) == [2, 1, 1] and _row(wv, 15, 2, 4) == [0, 1, 0] and _row(wv, 16, 2, 5) == [0, 0, 1, 1]


def test_reads_back_through_importer(res):
    """다시 올리기(근무표 파일 올리기 · 파일에서 읽기)가 쓰는 파서로 읽으면 그대로 돌아온다."""
    g = _parse_xlsx_sheets(res.content)[0]["rows"]
    assert g[2][1:36] == DAYS                              # 날짜 줄 = ISO — 클라이언트가 년월까지 안다
    assert g[3][:8] == ["이름", *"일월화수목금토"]
    for k, row in enumerate(ROWS):
        assert g[4 + k][:36] == (row + [""] * 36)[:36]       # '/D' · 빈칸 · '=간호04' 그대로
    assert [r[0] for r in g[8:16]] == ["D", "E", "N", "중", "근무자수", "D차지", "E차지", "N차지"]
    # 날짜 칸이 모두 숫자 → 붙여넣기 매칭이 사람 줄이 아니라고 보고 건너뛴다 (paste-import.js _matchGrid)
    assert all(c.isdigit() for r in g[8:16] for c in r[1:36])
    assert len(g) == 16


DEC = [(date(2026, 12, 1) + timedelta(i)).isoformat() for i in range(33)]   # 12/1(화) ~ 1/2(토)


def test_december_shows_the_whole_month(client):
    """12월 표 = 12/1~1/2 — 그 달이 한 시트에 다 보이고 계는 12/1~12/31(B~AF)만 센다. 첫 주기 묶음은 화~토 다섯 칸.
    추가 정보 없이도 나간다 — 차지 줄은 뺀다."""
    r = client.post("/api/schedules/export.xlsx", json={
        "year": 2026, "month": 12, "days": DEC, "rows": [["간호01", *(["N"] * 33)]]})
    assert r.status_code == 200, r.text
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    ws, wv = wb["12월"], openpyxl.load_workbook(io.BytesIO(r.content), data_only=True)["12월"]
    assert wb.sheetnames == ["12월"]
    assert ws["A1"].value == "2026년 12월 근무표 (12월 1일~1월 2일)"
    assert {"B2:F2", "G2:M2", "AB2:AH2"} <= {str(x) for x in ws.merged_cells.ranges}
    assert [ws[c].value for c in ("B2", "G2", "B4", "G4")] == ["4주기", "1주기", "화", "일"]
    assert ws["G5"].border.left.style == "medium" and ws["F5"].border.left.style == "thin"   # 굵은 선은 일요일 왼쪽
    assert ws["AK5"].value == '=COUNTIF(B5:AF5,"N")' and wv["AK5"].value == 31
    assert ws["AI5"].value == '=COUNTIF(B5:AF5,"D")' and wv["AR5"].value == 31     # 총근무
    assert [ws.cell(r, 1).value for r in range(6, 12)] == ["D", "E", "N", "중", "근무자수", None]
    assert ws["A5"].fill.fill_type is None and ws["B5"].value == "N"


def _stale(content):
    """두 시트의 수식 칸 가운데 든 값이 수식을 푼 값과 다른 칸."""
    wb, wv = openpyxl.load_workbook(io.BytesIO(content)), openpyxl.load_workbook(io.BytesIO(content), data_only=True)
    return [f"{ws.title}!{c.coordinate}" for ws in wb for row in ws.iter_rows() for c in row
            if c.data_type == "f" and (wv[ws.title][c.coordinate].value or "") != (_calc(ws, c.value) or "")]


def test_previous_month_sheet(client):
    """앞 달 시트를 같이 — 12/1~12/5 는 11월 표에도 있다. 12월 시트의 그 칸(B~F)은 11월 시트의 같은 이름 줄(AF~AJ)을 가리키고,
    계는 12월 시트 안에서 12/1 부터 센다 (결정 1-61)."""
    prev = {"year": 2026, "month": 11, "days": DAYS, "rows": [
        ["간호02", *(["D"] * 30), "N", "생", "N", "D", "N"],
        ["간호09", *(["N"] * 35)],                           # 이 달 명부에 없는 사람
        ["간호01", *(["N"] * 30), "n", "N", "OF", "OF", "생"],
        ["간호01", *(["N"] * 34)]]}                          # 같은 이름 — 나온 순서대로 짝짓는다. 12/5 는 빈칸
    r = client.post("/api/schedules/export.xlsx", json={"year": 2026, "month": 12, "days": DEC, "prev": prev, "rows": [
        ["간호01", *(["D"] * 5), *(["N"] * 28)],             # 12/1~12/5 에 보낸 값(D)은 쓰지 않는다 — 11월 시트 값
        ["간호02", *(["E"] * 5), "생", *(["D"] * 27)],
        ["간호03", *(["V"] * 5), *(["N"] * 28)],             # 11월 시트에 없는 사람 — 보낸 값 그대로
        ["간호01", "D"]]})
    assert r.status_code == 200, r.text
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    wv = openpyxl.load_workbook(io.BytesIO(r.content), data_only=True)["12월"]
    assert wb.sheetnames == ["11월", "12월"] and wb.active.title == "12월"      # 열면 이 달 시트
    ws = wb["12월"]
    ref = lambda c: f"""=IF('11월'!{c}="","",'11월'!{c})"""                       # noqa: E731
    assert [ws[c].value for c in ("B5", "F5", "B6", "F8")] == [ref("AF7"), ref("AJ7"), ref("AF5"), ref("AJ8")]
    assert [ws[c].value for c in ("B7", "G5", "G6")] == ["V", "N", "생"]          # 11월 시트에 없는 사람·12/6 부터는 값
    assert [wv[c].value for c in ("B5", "D5", "F5", "C6", "B8")] == ["n", "OF", "생", "생", "N"] and not wv["F8"].value
    assert [ws[f"{c}5"].value for c in ("AI", "AK", "AO")] == [f'=COUNTIF(B5:AF5,"{t}")' for t in "DN생"]
    assert [wv[f"AK{r}"].value for r in (5, 6, 7, 8)] == [28, 3, 26, 4]           # N: 2+26 · 3 · 26 · 4
    assert [wv[f"AO{r}"].value for r in (5, 6)] == [1, 2] and wv["AI6"].value == 26 and wv["AP7"].value == 5
    assert wv["B9"].value == 0 and wv["B11"].value == 3                           # 아래 인원 줄도 가리킨 값을 센다 (12/1 N 셋)
    assert wb["11월"]["AM5"].value == '=COUNTIF(B5:AE5,"N")'
    assert _stale(r.content) == []
    g = _parse_xlsx_sheets(r.content)                        # 다시 올리기 — 가리킨 칸도 값으로 읽힌다
    assert [s["name"] for s in g] == ["11월", "12월"] and g[1]["rows"][4][:7] == ["간호01", "n", "N", "OF", "OF", "생", "N"]
    # 앞 달 시트에 이 달 날짜가 없으면 보낸 값 그대로
    r = client.post("/api/schedules/export.xlsx", json={
        "year": 2026, "month": 12, "days": DEC, "prev": {**prev, "days": DAYS[:30]}, "rows": [["간호01", *(["D"] * 33)]]})
    assert openpyxl.load_workbook(io.BytesIO(r.content))["12월"]["B5"].value == "D"


@pytest.mark.parametrize("body", [
    {**BODY, "prev": {**BODY, "rows": []}},
    {**BODY, "days": ["2026-13-01"]},
    {**BODY, "days": []},
    {**BODY, "month": 0},
    {k: v for k, v in BODY.items() if k != "rows"},
    {**BODY, "rows": [[]]},
    {**BODY, "rows": []},
    {**BODY, "notes": [[0, 1]]},
    {**BODY, "year": "올해"},
])
def test_bad_input_400(client, body):
    r = client.post("/api/schedules/export.xlsx", json=body)
    assert r.status_code == 400
    assert r.json()["detail"].startswith("근무표 형식이 맞지 않습니다")


def test_leading_days_of_the_previous_month(client):
    """이 달 시트가 화면처럼 지난달 며칠부터 시작할 때 (결정 1-114) — 앞에 붙은 지난달 며칠(11/29·11/30)도 앞 달 시트의 같은 날짜를 가리키고,
    계는 12/1~12/31 칸만 센다. 주기 줄은 첫 주가 온전한 한 주(일~토)다."""
    days = [(date(2026, 11, 29) + timedelta(i)).isoformat() for i in range(35)]          # 11/29(일) ~ 1/2(토)
    prev = {"year": 2026, "month": 11, "days": DAYS, "rows": [["간호01", *(["D"] * 28), "N", "E", *(["OF"] * 5)]]}   # 11/29 N · 11/30 E
    r = client.post("/api/schedules/export.xlsx", json={"year": 2026, "month": 12, "days": days, "prev": prev, "rows": [
        ["간호01", "V", "V", *(["V"] * 5), *(["N"] * 28)],                                # 앞 일곱 칸에 보낸 값(V)은 쓰지 않는다 — 11월 시트 값
        ["간호02", "N", "N", *(["D"] * 33)]]})                                            # 11월 시트에 없는 사람 — 보낸 값 그대로
    assert r.status_code == 200, r.text
    wb = openpyxl.load_workbook(io.BytesIO(r.content))
    ws, wv = wb["12월"], openpyxl.load_workbook(io.BytesIO(r.content), data_only=True)["12월"]
    ref = lambda c: f"""=IF('11월'!{c}="","",'11월'!{c})"""                               # noqa: E731
    assert [ws[c].value for c in ("B5", "C5", "D5", "H5")] == [ref("AD5"), ref("AE5"), ref("AF5"), ref("AJ5")] and ws["I5"].value == "N"
    assert [wv[c].value for c in ("B5", "C5", "D5")] == ["N", "E", "OF"] and [ws[c].value for c in ("B6", "C6")] == ["N", "N"]
    assert ws["AM5"].value == '=COUNTIF(D5:AH5,"N")' and wv["AM5"].value == 26          # 12/6~12/31 의 N — 11/29 의 N 은 세지 않는다
    assert ws["AK6"].value == '=COUNTIF(D6:AH6,"D")' and wv["AK6"].value == 31 and wv["AM6"].value == 0   # 간호02 의 11/29·11/30 N 도 세지 않는다
    assert ws["B3"].value.date() == date(2026, 11, 29) and str(ws.merged_cells).count("B2:H2") == 1    # 첫 주기 칸이 일곱 날
    assert _stale(r.content) == []


def test_highlight_picker(res):
    """강조 (결정 1-105) — 제목 줄 오른쪽 칸의 목록에서 고르면 그 칸이 색으로 뜬다: 목록(데이터 유효성) + 조건부 서식 네 가지, 매크로 없음."""
    ws = openpyxl.load_workbook(io.BytesIO(res.content))["11월"]
    assert ws["AK1"].value == "강조" and ws["AM1"].value is None
    dv = ws.data_validations.dataValidation
    assert len(dv) == 1 and str(dv[0].sqref) == "AM1" and dv[0].type == "list"
    picks = dv[0].formula1.strip('"').split(",")
    assert picks[-7:] == ["1오프", "단독 나이트", "하루짜리 근무", "쉬고 나서 역방향", "하나씩 넘어가기", "같은 근무 5일", "6일 연속 근무"]
    assert {"D", "E", "N", "OF"} <= set(picks) and len(dv[0].formula1) <= 255
    rules = {str(rng.sqref): [r.formula[0] for r in rs] for rng, rs in ws.conditional_formatting._cf_rules.items()}
    grid = [k for k in rules if k.startswith("B5:AJ")]
    inner = [k for k in rules if k.startswith("C5:AI")]         # 이웃 칸을 보는 것은 첫 칸·끝 칸을 뺀다
    # 길게 이어진 둘은 오른쪽 숨긴 칸(AV~ · CK~)에 '여기까지 며칠째'를 세고, 그 칸부터 오른쪽 넷(다섯) 안에 5(6) 이상이 있는지 본다
    assert len(grid) == 1 and rules[grid[0]] == ['AND($AM$1<>"",B5=$AM$1)', 'AND($AM$1="같은 근무 5일",MAX(AV5:AZ5)>=5)', 'AND($AM$1="6일 연속 근무",MAX(CK5:CP5)>=6)']
    assert ws["AV5"].value == '=IF(OR(B5="D",B5="E"),IF(B5=A5,AU5+1,1),0)' and ws["CK6"].value.startswith('=IF(OR(B6="D",') and ws["CK6"].value.endswith(',CJ6+1,0)')
    assert ws.column_dimensions["AV"].hidden and ws.column_dimensions["CK"].hidden and not ws.column_dimensions["AT"].hidden
    assert len(inner) == 1 and [f.split(",")[0] for f in rules[inner[0]]] == [
        'AND($AM$1="1오프"', 'AND($AM$1="단독 나이트"', 'AND($AM$1="하루짜리 근무"', 'AND($AM$1="쉬고 나서 역방향"', 'AND($AM$1="하나씩 넘어가기"']
    assert 'NOT(OR(C5="D",C5="E",C5="N",C5="중",C5="D1"))' in rules[inner[0]][0] and 'C5="N",B5<>"N",D5<>"N"' in rules[inner[0]][1]
    assert not ws["AM1"].value and ws["B5"].fill.fgColor.rgb != "FFFFC000"      # 고르지 않으면 평소 모양

