"""공개 저장소 검사 (scripts/privacy_check.py, 2026-10-17) — 찾은 말은 찍지 않고 자리만.

진짜 말 목록은 리포 밖이라 여기선 지어낸 말(가나다병원·홍길순)로 본다.
"""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import privacy_check as pc  # noqa: E402


@pytest.fixture
def rules(tmp_path, monkeypatch):
    monkeypatch.setattr(pc, "CONF", tmp_path)          # 이 컴퓨터의 진짜 목록은 읽지 않는다
    monkeypatch.setenv("PRIVACY_PATTERNS", "# 주석\n가나다병원\n(?<![가-힣])길순(?!법)")
    (tmp_path / "private-names.txt").write_text("홍길동.\n", encoding="utf-8")
    return pc.load_rules()


def test_rules_and_scan_hide_the_word(rules):
    assert [rid for rid, _ in rules] == ["ci#1", "ci#2", "names#1"]
    hits = pc.scan("README.md", "첫 줄\n가나다병원 로고\n지길순 · 길순법\n길순이 줬다\n홍길동 맞음 홍길동X", rules)
    assert hits == ["README.md:2: ci#1", "README.md:4: ci#2"]   # 이름 글자는 그대로만 (홍길동. ≠ 홍길동X)
    assert not any("가나다" in h or "길순" in h for h in hits)


def test_added_lines_only_with_line_numbers(rules):
    diff = ("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -3,0 +4,2 @@\n+괜찮은 줄\n+가나다병원\n"
            "@@ -9 +11 @@\n-가나다병원 지운 줄\n+바꾼 줄\n")
    assert list(pc.added_lines(diff)) == [("a.md", 4, "괜찮은 줄"), ("a.md", 5, "가나다병원"), ("a.md", 11, "바꾼 줄")]
    assert pc.scan_diff(diff, rules) == ["a.md:5: ci#1"]


def test_claude_hook_checks_outgoing_text_only(rules, tmp_path, monkeypatch):
    body = tmp_path / "body.md"
    body.write_text("요약\n가나다병원 번표\n", encoding="utf-8")

    def run(cmd):
        monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"tool_input": {"command": cmd}})))
        return pc.claude_hook(rules)

    assert run('gh pr create --title "가나다병원 고침"') == ["명령:1: ci#1"]
    assert run(f"gh release edit v1 --notes-file {body}") == [f"{body}:2: ci#1"]
    assert run("git commit -q -F - <<'EOF'\n길순이 고른 범위\nEOF") == ["명령:2: ci#2"]
    assert run("git grep -n 가나다병원") == []                 # 찾기는 내보내는 글이 아니다
    assert run("gh pr list --search 가나다병원") == []
    assert run("git push origin HEAD:refs/heads/가나다병원-v5") == ["명령:1: ci#1"]   # 브랜치 이름은 공개된다


def test_require_fails_without_rules(tmp_path, monkeypatch):
    monkeypatch.setattr(pc, "CONF", tmp_path)
    monkeypatch.delenv("PRIVACY_PATTERNS", raising=False)
    assert pc.main(["--require", "README.md"]) == 1
    assert pc.main(["README.md"]) == 0
