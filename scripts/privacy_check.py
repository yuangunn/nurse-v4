"""공개 저장소로 나가는 글에서 병원 이름·사람 이름을 찾는다 (2026-10-17).

찾은 말은 찍지 않는다 — 자리(파일:줄)와 규칙 번호만. 말 목록 자체가 개인정보라 리포 밖에 둔다:
  ~/.config/nurse-v4/private-words.txt   한 줄에 정규식 하나 (# 은 주석, 대소문자 무시)
  ~/.config/nurse-v4/private-names.txt   한 줄에 실명 하나 (글자 그대로)
  환경 변수 PRIVACY_PATTERNS             CI 시크릿 — words 파일과 같은 형식
병동 번호는 괜찮다 — 10층 넘는 병원이면 어디나 있다.

  python3 scripts/privacy_check.py --staged          # pre-commit: 이번 커밋에 더하는 줄
  python3 scripts/privacy_check.py --msg FILE        # commit-msg
  python3 scripts/privacy_check.py --range A..B      # CI: 범위의 커밋 메시지 + 더한 줄
  python3 scripts/privacy_check.py --stdin 이름      # PR 제목·본문 같은 글
  python3 scripts/privacy_check.py --claude-hook     # Claude Code PreToolUse(Bash) — gh·git commit 글을 내보내기 전에
  python3 scripts/privacy_check.py FILE...           # 파일 통째로
  --require: 말 목록이 하나도 없으면 실패 (CI 에서 시크릿이 빠졌을 때 초록으로 넘어가지 않게)
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

CONF = Path.home() / ".config" / "nurse-v4"


def load_rules():
    rules = []

    def add(src, text, literal):
        lines = [ln.strip() for ln in text.splitlines()]
        for k, ln in enumerate([ln for ln in lines if ln and not ln.startswith("#")], 1):
            rules.append((f"{src}#{k}", re.compile(re.escape(ln) if literal else ln, re.I)))

    add("ci", os.environ.get("PRIVACY_PATTERNS", ""), False)
    for name, literal in (("private-words.txt", False), ("private-names.txt", True)):
        f = CONF / name
        if f.exists():
            add(name.split(".")[0].replace("private-", ""), f.read_text(encoding="utf-8"), literal)
    return rules


def scan(label, text, rules, first_line=1):
    return [f"{label}:{n}: {rid}"
            for n, line in enumerate(text.splitlines(), first_line)
            for rid, rx in rules if rx.search(line)]


def added_lines(diff):
    """git diff -U0 에서 더한 줄만 (파일, 줄 번호, 글)."""
    path, n = "?", 0
    for line in diff.splitlines():
        if line.startswith("+++ "):
            path = line[6:] if line.startswith("+++ b/") else line[4:]
        elif line.startswith("@@"):
            n = int(re.search(r"\+(\d+)", line).group(1))
        elif line.startswith("+"):
            yield path, n, line[1:]
            n += 1


def scan_diff(diff, rules):
    return [h for path, n, text in added_lines(diff) for h in scan(path, text, rules, n)]


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8",
                          errors="replace", check=True).stdout


def claude_hook(rules):
    cmd = (json.load(sys.stdin).get("tool_input") or {}).get("command", "")
    # 내보내는 명령만 — 조회(gh pr list·git grep)는 말 목록의 말을 써도 된다. push 는 브랜치·태그 이름이 공개된다.
    if not re.search(r"\bgh\s+(pr\s+(create|edit|comment|review|merge)|release\s+(create|edit|upload)"
                     r"|issue\s+(create|edit|comment)|api|gist\s+create|repo\s+(create|edit))\b"
                     r"|\bgit\s+(commit|tag|push)\b", cmd):
        return []
    hits = scan("명령", cmd, rules)
    for m in re.finditer(r"(?:--body-file|--notes-file|--file|-F)[=\s]+(\S+)", cmd):
        p = Path(os.path.expanduser(m.group(1).strip("'\"")))
        if p.is_file():
            hits += scan(str(p), p.read_text(encoding="utf-8", errors="replace"), rules)
    return hits


def main(argv):
    rules = load_rules()
    require = "--require" in argv
    argv = [a for a in argv if a != "--require"]
    if not rules:
        print("privacy_check: 말 목록이 없다 (~/.config/nurse-v4/ 또는 PRIVACY_PATTERNS)", file=sys.stderr)
        return 1 if require else 0
    if argv[:1] == ["--claude-hook"]:
        hits = claude_hook(rules)
    elif argv[:1] == ["--staged"]:
        hits = scan_diff(git("diff", "--cached", "-U0", "--no-color"), rules)
    elif argv[:1] == ["--msg"]:
        msg = Path(argv[1]).read_text(encoding="utf-8", errors="replace")
        hits = scan("커밋 메시지", "\n".join(ln for ln in msg.splitlines() if not ln.startswith("#")), rules)
    elif argv[:1] == ["--range"]:
        a, b = argv[1].split("..")
        hits = []
        for rec in git("log", "--format=%h%x00%B%x1e", f"{a}..{b}").split("\x1e"):
            if rec.strip():
                sha, body = rec.strip().split("\x00", 1)
                hits += scan(f"커밋 {sha}", body, rules)
        hits += scan_diff(git("diff", "-U0", "--no-color", f"{a}...{b}"), rules)
    elif argv[:1] == ["--stdin"]:
        hits = scan(argv[1] if len(argv) > 1 else "입력", sys.stdin.read(), rules)
    else:
        hits = [h for f in argv for h in scan(f, Path(f).read_text(encoding="utf-8", errors="replace"), rules)]
    if hits:
        print("공개 저장소로 나가는 글에 병원 이름·실명으로 보이는 말이 있다 — 고친 뒤 다시:", file=sys.stderr)
        print("\n".join(f"  {h}" for h in hits), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
