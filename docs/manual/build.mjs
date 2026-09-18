// 설명서 PDF 만들기 — 페이지 넘침·바닥글 겹침을 먼저 검사하고 A4 로 출력한다.
//   node docs/manual/build.mjs            (그림은 미리 docs/manual/shots/ 에 있어야 한다 → shots.mjs)
//   PW_CHROMIUM=/path/to/chrome node docs/manual/build.mjs
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC  = path.join(HERE, 'manual.html');
const OUT  = path.join(HERE, '어싸인_배정표_사용설명서.pdf');
const EXE  = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

if (!fs.existsSync(path.join(HERE, 'shots'))) {
  console.error('그림이 없다 — 먼저 node docs/manual/shots.mjs 로 캡처할 것');
  process.exit(1);
}

const browser = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 900, height: 1300 } });
await page.goto('file://' + SRC, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1200);

// 한 쪽에 다 들어가는지 — 스크롤 넘침 + 바닥글(쪽 번호) 겹침
const bad = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.pg').forEach((pg, i) => {
    const ft = pg.querySelector('.pgft');
    const ftTop = ft ? ft.getBoundingClientRect().top : pg.getBoundingClientRect().bottom;
    let maxB = -1e9, who = '';
    pg.querySelectorAll(':scope > *').forEach(el => {
      if (el.classList.contains('pgft') || el.classList.contains('pgnum') || el.classList.contains('foot')) return;
      const r = el.getBoundingClientRect();
      if (r.bottom > maxB) { maxB = r.bottom; who = el.tagName + '.' + el.className; }
    });
    const gap = Math.round(ftTop - maxB);
    const over = pg.scrollHeight > pg.clientHeight + 2;
    if (gap < 8 || over) out.push({ pg: i + 1, gap, over, who });
  });
  return out;
});
if (bad.length) {
  console.error('넘치는 쪽:', JSON.stringify(bad));
  await browser.close();
  process.exit(1);
}

await page.pdf({ path: OUT, format: 'A4', printBackground: true, preferCSSPageSize: true,
                 margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' } });
await browser.close();
const n = (fs.readFileSync(SRC, 'utf8').match(/class="pg[ "]/g) || []).length;
console.log(`PDF ${path.basename(OUT)} — ${n}쪽 · ${Math.round(fs.statSync(OUT).size / 1024)} KB`);
