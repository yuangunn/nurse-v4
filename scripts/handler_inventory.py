#!/usr/bin/env python3
"""화면 핸들러 인벤토리 비교 — UI 재배치 때 '기능이 사라지지 않았는지' 기계적으로 확인한다.

index.html 의 @click / @change / @dblclick / @contextmenu / @keydown* / @blur / @input / @drop / x-model
표현식을 정규화해 집합으로 뽑고, 두 파일(보통 main 과 작업본)의 차이를 보고한다.
메뉴 닫기용 꼬리(`;open=false`)는 떼고 비교한다 — 버튼을 메뉴 안으로 옮겨도 같은 핸들러로 본다.

사용:
  python3 scripts/handler_inventory.py <(git show origin/main:frontend/index.html) frontend/index.html
  python3 scripts/handler_inventory.py frontend/index.html            # 목록만 출력

REMOVED 에 뜬 항목은 전부 '의도한 제거'로 설명할 수 있어야 한다 (M7, 결정 1-22).
"""
import json, re, sys

PAT = re.compile(r'(@click(?:\.[a-z.]+)?|@change|@dblclick|@contextmenu(?:\.[a-z]+)?|@keydown(?:\.[a-z.]+)?'
                 r'|@blur|@input|@drop(?:\.[a-z]+)?|x-model(?:\.[a-z]+)?)="([^"]*)"')

def inventory(path):
    src = open(path, encoding='utf-8').read()
    items = set()
    for attr, expr in PAT.findall(src):
        e = re.sub(r'\s+', ' ', expr.strip())
        e = re.sub(r';\s*open=false$', '', e)           # 메뉴 닫기 꼬리 제거
        if e in ('open=!open', 'open=false'):            # 메뉴 자체의 열고 닫기는 기능이 아니다
            continue
        items.add(f"{attr.split('.')[0]}={e}")
    return items

def main(argv):
    if len(argv) == 2:
        print(json.dumps(sorted(inventory(argv[1])), ensure_ascii=False, indent=0)); return 0
    if len(argv) != 3:
        print(__doc__); return 2
    before, after = inventory(argv[1]), inventory(argv[2])
    removed, added = sorted(before - after), sorted(after - before)
    print(f"before {len(before)} · after {len(after)} · removed {len(removed)} · added {len(added)}")
    for r in removed: print("REMOVED", r)
    for a in added:   print("added  ", a)
    return 1 if removed else 0

if __name__ == '__main__':
    sys.exit(main(sys.argv))
