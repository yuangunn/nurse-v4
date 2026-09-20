#!/usr/bin/env python3
"""배정표 양식의 테두리 구멍 찾기.

병동이 주는 양식은 판마다 다르고, 한 칸만 서식이 어긋나 있어도 그 자리만 선이
빠진 채 매주 인쇄된다. 실제로 122 양식 H18(월↔화 경계)이 그랬다 — 사람이
쓰다가 알아챘다.

  구멍  양쪽 칸 어느 쪽도 선을 안 그린다 → 실패. 인쇄물에 칸이 열려 보인다.
  가늘다 선은 있는데 주위보다 얇다 → 안내만. 병동 원본이 원래 그런 경우가 많다.

양식 구조는 가정하지 않는다 — 요일 줄과 병합을 읽어 요일 칸을 찾아낸다.
"""
import re, sys, zipfile
from pathlib import Path

WD = set('일월화수목금토')

def colnum(s):
    n = 0
    for ch in s: n = n*26 + (ord(ch)-64)
    return n

def colname(n):
    s = ''
    while n: n, r = divmod(n-1, 26); s = chr(65+r) + s
    return s

def load(path):
    z = zipfile.ZipFile(path)
    name = [n for n in z.namelist() if re.match(r'xl/worksheets/sheet\d+\.xml$', n)][0]
    sh = z.read(name).decode('utf8')
    st = z.read('xl/styles.xml').decode('utf8')
    try:
        ss = [re.sub(r'<[^>]+>', '', s) for s in re.findall(
            r'<si>(.*?)</si>', z.read('xl/sharedStrings.xml').decode('utf8'), re.S)]
    except KeyError:
        ss = []
    xf = re.findall(r'<xf\b[^>]*/>|<xf\b.*?</xf>',
                    re.search(r'<cellXfs count="\d+">(.*?)</cellXfs>', st, re.S).group(1), re.S)
    borders = re.findall(r'<border\b[^>]*/>|<border\b.*?</border>',
                         re.search(r'<borders count="\d+">(.*?)</borders>', st, re.S).group(1), re.S)
    style, text = {}, {}
    for m in re.finditer(r'<c\s+r="([A-Z]+\d+)"([^>]*?)(?:/>|>(.*?)</c>)', sh, re.S):
        ref, attr, inner = m.group(1), m.group(2), m.group(3)
        sm = re.search(r's="(\d+)"', attr)
        style[ref] = int(sm.group(1)) if sm else 0
        if not inner: continue
        v = re.search(r'<v>(.*?)</v>', inner, re.S)
        if v: text[ref] = ss[int(v.group(1))] if 't="s"' in attr else v.group(1)
        else:
            t = re.findall(r'<t[^>]*>(.*?)</t>', inner, re.S)
            if t: text[ref] = ''.join(t)
    merges = []
    for ref in re.findall(r'<mergeCell\s+ref="([^"]+)"', sh):
        a, b = ref.split(':')
        c1, r1 = re.match(r'([A-Z]+)(\d+)', a).groups()
        c2, r2 = re.match(r'([A-Z]+)(\d+)', b).groups()
        merges.append((colnum(c1), int(r1), colnum(c2), int(r2)))
    return dict(style=style, text=text, merges=merges, xf=xf, borders=borders)

def side(D, ref, which):
    s = D['style'].get(ref, 0)
    bid = re.search(r'borderId="(\d+)"', D['xf'][s]) if s < len(D['xf']) else None
    b = D['borders'][int(bid.group(1))] if bid else D['borders'][0]
    m = re.search(r'<%s([^>]*?)(/>|>)' % which, b)
    if not m: return None
    st = re.search(r'style="([^"]+)"', m.group(1))
    return st.group(1) if st else None

def merged(D, c1, r1, c2, r2):
    return any(a <= c1 <= c and b <= r1 <= d and a <= c2 <= c and b <= r2 <= d
               for (a, b, c, d) in D['merges'])

def layout(D):
    """요일 줄 → 요일 칸(병합 폭째) → 표 줄 범위."""
    rows = {}
    for ref in D['text']:
        c, r = re.match(r'([A-Z]+)(\d+)', ref).groups()
        rows.setdefault(int(r), []).append(colnum(c))
    wd_row = next((r for r in sorted(rows)
                   if sum(1 for c in rows[r] if D['text'].get(colname(c)+str(r), '').strip() in WD) >= 5), None)
    if not wd_row: raise SystemExit('요일 줄을 찾지 못했습니다')
    starts = sorted(c for c in rows[wd_row]
                    if D['text'].get(colname(c)+str(wd_row), '').strip() in WD)
    blocks = []
    for c in starts:
        end = c
        for (a, b, c2, d) in D['merges']:
            if a == c and b <= wd_row <= d: end = max(end, c2)
        blocks.append((c, end))
    sec = [r for r in sorted(rows) if r > wd_row
           and D['text'].get('A'+str(r), '').strip() in ('D', 'E', 'N')]
    if not sec: raise SystemExit('D·E·N 구역을 찾지 못했습니다')
    stop = next((r for r in sorted(rows)
                 if r > wd_row and D['text'].get('A'+str(r), '').strip() == '구분'), None)
    last = (stop - 1) if stop else max(rows)
    return blocks, list(range(sec[0], last + 1))

def check(path):
    D = load(path)
    blocks, rows = layout(D)
    inner = {c for a, b in blocks for c in range(a, b)}
    span = range(blocks[0][0], blocks[-1][1])
    holes, thin = [], []
    for r in rows:
        for c in span:
            if merged(D, c, r, c+1, r): continue
            v = side(D, colname(c)+str(r), 'right') or side(D, colname(c+1)+str(r), 'left')
            ref = f'{colname(c)}{r}|{colname(c+1)}{r}'
            if v is None: holes.append((ref, '세로'))
            elif c not in inner and v != 'medium': thin.append((ref, '요일 경계', v))
    lo, hi = blocks[0][0]-1, blocks[-1][1]+1     # 표 바깥 좌·우
    for r in rows:
        for a, b, lbl in ((lo, lo+1, '왼쪽 바깥'), (hi-1, hi, '오른쪽 바깥')):
            if merged(D, a, r, b, r): continue
            if (side(D, colname(a)+str(r), 'right') or side(D, colname(b)+str(r), 'left')) is None:
                holes.append((f'{colname(a)}{r}|{colname(b)}{r}', lbl))
    for i in range(len(rows)-1):
        r1, r2 = rows[i], rows[i+1]
        for c in range(blocks[0][0], blocks[-1][1]+1):
            if merged(D, c, r1, c, r2): continue
            if (side(D, colname(c)+str(r1), 'bottom') or side(D, colname(c)+str(r2), 'top')) is None:
                holes.append((f'{colname(c)}{r1}/{colname(c)}{r2}', '가로'))
    return holes, thin, blocks, rows

def main(paths):
    bad = 0
    for p in paths:
        holes, thin, blocks, rows = check(p)
        print(f'── {Path(p).name}  (요일 칸 {len(blocks)}개 · 표 {rows[0]}~{rows[-1]}행)')
        for ref, kind in holes:
            print(f'   구멍  {ref:<12} {kind} — 양쪽 다 선이 없습니다')
        for ref, kind, v in thin:
            print(f'   안내  {ref:<12} {kind}가 {v} (주위는 medium)')
        if not holes and not thin: print('   이상 없음')
        bad += len(holes)
    if bad:
        print(f'\n테두리 구멍 {bad}곳 — 그 칸은 인쇄물에서 열려 보입니다.')
        return 1
    print('\n테두리 구멍 없음')
    return 0

def templates():
    # 맥은 한글 파일 이름을 NFD 로도 저장한다 — 101 양식이 그렇게 들어와 있어서
    # 한글 패턴으로 glob 하면 조용히 빠진다. 정규화해서 고른다.
    import unicodedata as u
    return sorted((str(p) for p in Path('standalone').glob('*.xlsx')
                   if u.normalize('NFC', p.name).startswith('병실 배정표')),
                  key=lambda x: u.normalize('NFC', x))

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:] or templates()))
