#!/usr/bin/env python3
"""도움말에 넣을 그림을 **실제 화면을 구동해서** 만든다.

손으로 그린 설명 그림은 화면이 바뀌면 금방 거짓말이 된다. 그래서 진짜 assign.html 을
헤드리스 브라우저로 띄우고, 장면마다 상태를 만든 뒤 찍어서 GIF/PNG 로 잇는다.

사용:  python3 scripts/make-help-media.py [장면이름 ...]
결과:  standalone/help/<이름>.gif|png  →  build-assign-standalone.mjs 가 base64 로 심는다
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML = os.path.join(ROOT, "standalone", "assign.html")
OUT = os.path.join(ROOT, "standalone", "help")
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# 모든 장면이 공유하는 샘플 병동 — 실제 사용 모습과 최대한 비슷하게
SAMPLE = """
const A=window.__app;
A.memoryMode();
A.ingestGrid([['이름','8/2','8/3','8/4','8/5','8/6','8/7','8/8'],
  ['김수진','DC','DC','DC','DC','D','E','OF'],
  ['이영희','D','D','D','D','E','E','E'],
  ['박민정','D','D','E','D','OF','D','D'],
  ['최은주','E','E','E','D','EC','OF','N'],
  ['정하나','E','EC','E','E','N','N','OF'],
  ['한지민','N','N','NC','E','N','D','D'],
  ['송가연','N','N','OF','N','OF','N','N'],
  ['오유진','OF','OF','D','N','D','D','E']]);
A.confirmPaste();
A.store.events['2026-08-05']='병동 감염관리 교육 14:00';
A.recompute();
A.wkSunday=new Date(2026,7,2);
$('#fileInfo').textContent='assign-data.js';
"""

# 장면 정의: (창 크기, 자를 영역 선택자들, 프레임별 스크립트, 프레임 길이(ms))
SCENES: dict[str, dict] = {
    "week": dict(size=(1240, 1120), sel=[".wknav", "#wkBody"], hold=[3000], steps=[
        "A.show('week');",
    ]),
    "swap": dict(size=(1240, 1120), sel=[".wknav", "#wkBody", "#pick"], hold=[1500, 2600, 2600], steps=[
        "A.show('week');",
        """A.show('week');
           const day=A.dayInfo('2026-08-05').D;
           A.openPick(day.labels['B'],'2026-08-05',430,250);""",
        """A.show('week');
           const day=A.dayInfo('2026-08-05').D;
           A.openPick(day.labels['B'],'2026-08-05',430,250); pickChoose('C');""",
    ]),
    "rooms": dict(size=(1240, 1120), sel=[".wknav", "#wkBody", "#rpick"], hold=[1500, 2800, 2400], steps=[
        "A.show('week');",
        "A.show('week'); A.openRoomPick({kind:'day',iso:'2026-08-05',P:'D',l:'A'},430,250);",
        """A.show('week'); A.openRoomPick({kind:'day',iso:'2026-08-05',P:'D',l:'A'},430,250);
           toggleRoom('1012'); toggleRoom('1005');""",
    ]),
    "paste2": dict(size=(1240, 1150), sel=["#scrPaste"], hold=[1800, 3200, 2600], steps=[
        "A.show('paste');",
        """A.show('paste');
           A.ingestGrid([['D','D','E'],['OF','D','E'],['E','E','OF'],['N','OF','D'],
                         ['D','E','E'],['N','N','OF'],['OF','N','N']]);
           setPasteStart('iso','2026-08-09');""",
        """A.ingestGrid([['D','D','E'],['OF','D','E'],['E','E','OF'],['N','OF','D'],
                         ['D','E','E'],['N','N','OF'],['OF','N','N']]);
           setPasteStart('iso','2026-08-09'); A.confirmPaste();""",
    ]),
    "codes": dict(size=(1240, 1150), sel=["#pvCard"], hold=[3000, 2600], steps=[
        """A.show('paste');
           A.ingestGrid([['경가','D','E'],['조가','D','E'],['D','경가','OF'],['N','OF','조가'],
                         ['D','E','E'],['N','N','OF'],['OF','N','N']]);
           setPasteStart('iso','2026-08-09');""",
        """A.show('paste');
           A.ingestGrid([['경가','D','E'],['조가','D','E'],['D','경가','OF'],['N','OF','조가'],
                         ['D','E','E'],['N','N','OF'],['OF','N','N']]);
           setPasteStart('iso','2026-08-09');
           mapUnknown('경가','leave'); mapUnknown('조가','alias','OF');""",
    ]),
    "edit": dict(size=(1480, 820), sel=["#scrEdit"], hold=[1600, 2200, 2600], steps=[
        "A.show('edit');",
        "A.show('edit'); sel={r:1,c:9,r2:3,c2:12}; paintEdit();",
        """A.show('edit'); sel={r:1,c:9,r2:3,c2:12};
           for(let r=1;r<=3;r++) for(let c=9;c<=12;c++) edSet(r,c,'OF');
           paintEdit();""",
    ]),
}

HARNESS = """
<script>
(function(){
  try{ localStorage.setItem('assignSeenIntro','1'); localStorage.setItem('assignTheme','light'); }catch(e){}
})();
setTimeout(()=>{
  try{
    applyTheme();                       // 도움말 그림은 항상 밝은 화면으로
    __SAMPLE__
    __STEP__
  }catch(e){ document.title='ERR:'+e.message; return; }
  setTimeout(()=>{
    const sels=__SEL__;
    let x1=1e9,y1=1e9,x2=-1e9,y2=-1e9,n=0;
    for(const s of sels){
      const el=document.querySelector(s);
      if(!el) continue;
      const r=el.getBoundingClientRect();
      if(r.width<2||r.height<2) continue;
      n++; x1=Math.min(x1,r.left); y1=Math.min(y1,r.top);
      x2=Math.max(x2,r.right); y2=Math.max(y2,r.bottom);
    }
    document.title = n ? ('BOX:'+[Math.round(x1),Math.round(y1),Math.round(x2),Math.round(y2)].join(',')) : 'BOX:none';
  },250);
},900);
</script>
"""


def run_chrome(args: list[str]) -> str:
    return subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                           "--force-device-scale-factor=2", *args],
                          capture_output=True, text=True, timeout=120).stdout


def capture(scene: str, spec: dict, tmp: str) -> list[Image.Image]:
    """프레임을 모두 찍은 뒤 **같은 영역**으로 자른다 — 프레임마다 자르면 GIF 가 덜컹거린다."""
    html = open(HTML, encoding="utf-8").read()
    shots: list[Image.Image] = []
    boxes: list[tuple[int, int, int, int]] = []
    for i, step in enumerate(spec["steps"]):
        page = html.replace("</body>", HARNESS
                            .replace("__SAMPLE__", SAMPLE)
                            .replace("__STEP__", step)
                            .replace("__SEL__", json.dumps(spec["sel"])) + "</body>")
        f = os.path.join(tmp, f"{scene}{i}.html")
        open(f, "w", encoding="utf-8").write(page)
        url = "file://" + f
        w, h = spec["size"]
        size = f"--window-size={w},{h}"
        # ① 자를 영역을 화면에서 직접 재고 ② 같은 상태를 찍는다
        dom = run_chrome([size, "--virtual-time-budget=6000", "--dump-dom", url])
        m = re.search(r"<title>BOX:([\d,]+)</title>", dom)
        shot = os.path.join(tmp, f"{scene}{i}.png")
        run_chrome([size, "--virtual-time-budget=6000", f"--screenshot={shot}", url])
        img = Image.open(shot).convert("RGB")
        shots.append(img)
        if m:
            x1, y1, x2, y2 = (int(v) * 2 for v in m.group(1).split(","))   # 2배 스케일
            boxes.append((x1, y1, x2, y2))
    if not boxes:
        return shots
    pad = 24
    W = min(im.width for im in shots)
    H = min(im.height for im in shots)
    box = (max(0, min(b[0] for b in boxes) - pad), max(0, min(b[1] for b in boxes) - pad),
           min(W, max(b[2] for b in boxes) + pad), min(H, max(b[3] for b in boxes) + pad))
    frames = [im.crop(box) for im in shots]
    print(f"  {scene}: {len(frames)}프레임 {frames[0].width}x{frames[0].height}")
    return frames


def save(scene: str, frames: list[Image.Image], hold: list[int]) -> str:
    os.makedirs(OUT, exist_ok=True)
    # 프레임 크기를 맞추고(가장 큰 쪽 기준) 화면 폭 900 으로 줄인다 — 도움말 패널 폭에 맞춤
    W = max(f.width for f in frames)
    H = max(f.height for f in frames)
    fixed = []
    for f in frames:
        canvas = Image.new("RGB", (W, H), (255, 255, 255))
        canvas.paste(f, (0, 0))
        scale = min(1.0, 900 / W)
        fixed.append(canvas.resize((round(W * scale), round(H * scale)), Image.LANCZOS))
    if len(fixed) == 1:
        path = os.path.join(OUT, scene + ".png")
        fixed[0].convert("P", palette=Image.ADAPTIVE, colors=128).save(path, optimize=True)
    else:
        path = os.path.join(OUT, scene + ".gif")
        pal = [f.convert("P", palette=Image.ADAPTIVE, colors=96) for f in fixed]
        pal[0].save(path, save_all=True, append_images=pal[1:], loop=0,
                    duration=hold, optimize=True, disposal=2)
        # 프레임이 합쳐졌다면 장면 설정이 화면에 반영되지 않은 것 — 조용히 넘어가면 안 된다
        got = Image.open(path).n_frames
        if got != len(pal):
            print(f"  [!] 프레임 {len(pal)}개인데 {got}개만 저장됨 — 화면이 안 바뀐 프레임이 있습니다")
    print(f"  → {os.path.relpath(path, ROOT)}  {os.path.getsize(path)/1024:.0f}KB")
    return path


def main() -> int:
    if not os.path.isfile(CHROME):
        print("Chrome 을 찾지 못했습니다:", CHROME)
        return 1
    want = sys.argv[1:] or list(SCENES)
    tmp = tempfile.mkdtemp(prefix="helpmedia")
    try:
        for scene in want:
            spec = SCENES.get(scene)
            if not spec:
                print("모르는 장면:", scene)
                continue
            print(scene)
            frames = capture(scene, spec, tmp)
            save(scene, frames, spec["hold"])
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("\n완료 — node scripts/build-assign-standalone.mjs 로 assign.html 에 심으세요.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
