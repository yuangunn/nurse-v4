# -*- coding: utf-8 -*-
"""app.js의 [start_anchor, end_anchor) 구간(섹션 주석 단위)을 잘라
frontend/js/modules/<modfile>로 옮기고, app.js에 스프레드 + index.html에 script를 추가.
순수 컷-페이스트(this.* 유지) — 로직 변경 없음. CRLF 보존.

usage: py _extract_module.py "<start_anchor>" "<end_anchor>" <modfile> <ModGlobal> "<desc>"
"""
import sys
CR = "\r\n"
start_anchor, end_anchor, modfile, modglobal, desc = sys.argv[1:6]
app = "frontend/js/app.js"
s = open(app, encoding="utf-8", newline="").read()

assert s.count(start_anchor) == 1, f"start anchor x{s.count(start_anchor)}: {start_anchor!r}"
assert s.count(end_anchor) == 1, f"end anchor x{s.count(end_anchor)}: {end_anchor!r}"
a = s.index(start_anchor); b = s.index(end_anchor)
assert a < b, "start must precede end"
block = s[a:b]
# 모듈 합성부(파일 끝)를 침범하지 않도록 가드
assert "// ── 외부 모듈 합성" not in block, "block overlaps module-composition footer!"
# ⚠ 게터 가드: 스프레드(...Module())는 compose 시점에 게터를 '실행'한다. 이때 this는
# 모듈 임시 객체라 this.* 가 undefined → throw로 컴포넌트 전체가 깨진다(Phase 5에서 발견).
# 게터/상태는 app.js 본체 리터럴에만 두고, 모듈엔 일반 메서드만 옮긴다.
import re as _re
_getters = _re.findall(r"\r?\n    get [A-Za-z_]\w*", block)
assert not _getters, ("block contains getter(s) — cannot move to spread module: "
                      + str(_getters) + ". Move getters back to app.js first.")
assert block.count("(){") + block.count(") {") + block.count("){") >= 1, "block has no method?"

header = (
 "/* ────────────────────────────────────────────────────────────────────────────" + CR
 + f" * {desc}" + CR
 + " *" + CR
 + f" * 사용: app() 반환 객체에 `...{modglobal}()` 로 스프레드. 모든 메서드는 this.* 사용." + CR
 + " * ─────────────────────────────────────────────────────────────────────────── */" + CR
 + f"window.{modglobal} = function() {{" + CR
 + "  return {" + CR)
footer = CR + "  };" + CR + "};" + CR
open(f"frontend/js/modules/{modfile}", "w", encoding="utf-8", newline="").write(
    header + block.rstrip() + CR + footer)

# app.js에서 블록 제거
s2 = s[:a] + s[b:]
# 스프레드 추가: 합성 주석 바로 다음 줄에 삽입
cm = "    // ── 외부 모듈 합성"
ci = s2.index(cm); le = s2.index(CR, ci) + len(CR)
spread = f"    ...(window.{modglobal} ? window.{modglobal}() : {{}})," + CR
assert spread not in s2, "spread already present"
s2 = s2[:le] + spread + s2[le:]
open(app, "w", encoding="utf-8", newline="").write(s2)

# index.html에 script 태그 추가 (app.js 직전)
h = "frontend/index.html"; hs = open(h, encoding="utf-8", newline="").read()
tag = f'  <script src="js/modules/{modfile}"></script>' + CR
appjs = '  <script src="js/app.js"></script>'
assert hs.count(appjs) == 1 and tag not in hs, "index.html anchor problem"
hs = hs.replace(appjs, tag + appjs, 1)
open(h, "w", encoding="utf-8", newline="").write(hs)

print(f"[OK] {modfile}: block {block.count(CR)} lines -> module; app.js now {s2.count(CR)} lines")
