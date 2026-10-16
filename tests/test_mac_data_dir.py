"""맥 앱의 데이터는 앱 밖(~/Library/Application Support/NurseScheduler)에 둔다 (2026-10-15).

맥엔 APPDATA 가 없어 데이터가 `Path(__file__).parent.parent / "data"` — 번들 안 `.app/…/_internal/data` —
로 갔다. 새 판을 응용 프로그램 폴더에 끌어 넣어 바꾸면 앱이 통째로 바뀌므로 명부·저장본이 함께 지워진다.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

from server import database, profiles


@pytest.mark.parametrize("frozen,platform,where", [
    (True, "darwin", "home"),     # 맥 앱 → 앱 밖
    (False, "darwin", "repo"),    # py main.py 로 돌리는 개발 환경은 그대로 리포의 data/
    (True, "win32", "repo"),      # 윈도우는 늘 APPDATA 가 있다 — 없을 때의 폴백도 그대로
])
def test_data_dir_without_appdata(tmp_path, monkeypatch, frozen, platform, where):
    monkeypatch.delenv("APPDATA", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(sys, "platform", platform)
    if frozen:
        monkeypatch.setattr(sys, "frozen", True, raising=False)
    else:
        monkeypatch.delattr(sys, "frozen", raising=False)
    mac = tmp_path / "Library" / "Application Support" / "NurseScheduler"
    repo = Path(database.__file__).parent.parent / "data"
    want = mac if where == "home" else repo
    assert Path(database.get_db_path()).parent == want
    assert profiles._app_dir() == want


def test_appdata_still_wins(tmp_path, monkeypatch):
    monkeypatch.setenv("APPDATA", str(tmp_path / "ad"))
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert Path(database.get_db_path()).parent == tmp_path / "ad" / "NurseScheduler"
    assert profiles._app_dir() == tmp_path / "ad" / "NurseScheduler"
