"""명부 조사 양식 — 다른 병동이 채워 온 엑셀을 가져오기가 그대로 읽는다 (결정 1-80)."""
from __future__ import annotations

import base64
import io

from openpyxl import load_workbook

from server import api, database as db

H = api._SURVEY_HEADER


def _filled(people):
    """양식을 받아 예시 아래 줄부터 채운 xlsx 바이트. people = [{머리줄 이름: 값}]"""
    wb = load_workbook(io.BytesIO(api._build_nurse_survey_xlsx()))
    ws = wb.active
    first = 5 + len(api._SURVEY_EXAMPLE)
    for i, p in enumerate(people):
        for k, v in p.items():
            ws.cell(first + i, H.index(k) + 1, v)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _yes(**kw):
    base = {h: "예" for h in ("낮 근무", "저녁 근무", "야간 근무", "낮 차지", "저녁 차지", "야간 차지")}
    return {**base, "성별": "여", **kw}


def test_template_shape():
    ws = load_workbook(io.BytesIO(api._build_nurse_survey_xlsx())).active
    assert [c.value for c in ws[4]] == H                                  # 머리줄은 4행 — 시트 고르기(앞 5행의 '이름')가 찾는다
    assert ws["A5"].value == "예시" and ws["A7"].value == 1                # 예시 두 줄 아래부터 1번
    lists = {str(dv.sqref): dv.formula1 for dv in ws.data_validations.dataValidation}
    assert '"예,아니오"' in lists.values() and '"여,남"' in lists.values() and '"일,월,화,수,목,금,토"' in lists.values()
    import re
    assert all(re.match(r"^[A-Z]+7:", part) for ref in lists for part in ref.split())   # 고르기는 예시 아래(7행)부터


def test_filled_survey_imports(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    for n in db.get_nurses():
        db.delete_nurse(n["id"])
    import datetime as dt
    raw = _filled([
        _yes(이름="간호01", 팀="A", **{"주휴 요일": "수"}),
        _yes(이름="간호02", 팀="A", 성별="남", **{"야간 근무": "아니오", "야간 차지": "아니오", "임산부": "아니오"}),
        {"이름": "간호03", "팀": "B", "성별": "여", "낮 근무": "예", "저녁 근무": "예", "야간 근무": "아니오",
         "낮 차지": "아니오", "저녁 차지": "아니오", "야간 차지": "아니오", "신규": "예",
         "트레이닝 끝나는 날": dt.datetime(2026, 12, 20), "프리셉터 이름": "간호01", "전입일": "2026.12.1"},
        {"이름": "간호04", "팀": "B", "성별": "여", "낮 근무": "예", "저녁 근무": "예", "임산부": "예", "출산 예정일": "2027/3/10"},
    ])
    body = {"csv_b64": base64.b64encode(raw).decode(), "replace_all": False}
    pre = api.nurse_import_preview(dict(body))
    assert pre["parsed_count"] == 4 and len(pre["will_add"]) == 4
    msgs = " / ".join(e["message"] for e in pre["errors"])
    assert "간호04" in msgs and "출산 예정일 2027-03-10" in msgs                 # 임산부 안내
    assert "'야간 근무' 칸이 비어 있어 '예'로" in msgs                            # 비운 칸은 채운 값을 알린다
    assert "예시" not in msgs and db.get_nurses() == []                          # 미리보기는 저장하지 않는다

    api.nurse_import(dict(body))
    by = {n["name"]: n for n in db.get_nurses()}
    assert sorted(by) == ["간호01", "간호02", "간호03", "간호04"]                 # 예시 두 줄은 들어오지 않는다
    assert by["간호01"]["capable_shifts"] == ["DC", "D", "EC", "E", "NC", "N"] and by["간호01"]["juhu_day"] == 3
    assert by["간호02"]["capable_shifts"] == ["DC", "D", "EC", "E"] and by["간호02"]["gender"] == "male"
    assert [by[f"간호0{i}"]["seniority"] for i in (1, 2, 3, 4)] == [0, 1, 2, 3]     # 위에서부터 선임 순
    t = by["간호03"]
    assert t["capable_shifts"] == ["D", "E"] and t["is_trainee"] is True
    assert (t["training_end_date"], t["start_date"]) == ("2026-12-20", "2026-12-01")   # 엑셀 날짜·점 찍은 날짜
    assert t["preceptor_id"] == by["간호01"]["id"]                                # 이름으로 적은 프리셉터
    assert by["간호04"]["is_pregnant"] is True and by["간호01"]["is_pregnant"] is False

    # 다시 가져와도 사람이 겹쳐 생기지 않고, 양식에 없는 칸(야간전담)은 남는다
    db.upsert_nurse({**by["간호02"], "is_night_shift": True})
    again = api.nurse_import_preview(dict(body))
    assert again["will_add"] == []
    api.nurse_import(dict(body))
    assert len(db.get_nurses()) == 4
    assert {n["name"]: n for n in db.get_nurses()}["간호02"]["is_night_shift"] is True


def test_unknown_preceptor_and_plain_template_untouched(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path))
    db.init_db()
    for n in db.get_nurses():
        db.delete_nurse(n["id"])
    raw = _filled([_yes(이름="간호01", 신규="예", **{"프리셉터 이름": "없는 사람"})])
    pre = api.nurse_import_preview({"csv_b64": base64.b64encode(raw).decode()})
    assert any("프리셉터 '없는 사람'" in e["message"] for e in pre["errors"])
    # 예전 템플릿(id·이름·팀…)은 그대로 읽는다 — 조사 양식 변환을 타지 않는다
    rows = [api._NURSE_CSV_HEADER] + [list(r) for r in api._NURSE_CSV_EXAMPLE]
    assert api._survey_to_standard(rows) == (rows, [])
    assert len(api._parse_nurses_rows(rows)["nurses"]) == 4
