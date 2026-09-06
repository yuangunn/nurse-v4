// check_redesign.mjs — 리디자인 구현 검증기.
// 사용: py main.py (서버) 실행 후
//   node design_handoff/check/check_redesign.mjs [--url http://localhost:5757] [--shots out/]
// 요구: npm i -D playwright  &&  npx playwright install chromium
// 결과: 실패 항목을 표로 출력하고 exit 1. --shots 를 주면 spec 의 각 상태를 1920×1080 PNG 로 저장해
//       reference/*.png 와 나란히 비교할 수 있다 (사람 눈 비교 + 아래 자동 검사 둘 다 통과해야 DONE).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'spec.json'), 'utf8'));
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : []).filter(Boolean));
const URL = args.url || 'http://localhost:5757';
const SHOTS = args.shots ? path.resolve(args.shots) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// 축약 속성('1px solid rgb(…)' · Chromium outline 'rgb(…) solid 2px')은 rgb() 부분만 hex 로 바꾸고 '폭 스타일 색' 순서로 맞춘다
const shorthand = (v) => { const s = String(v).replace(/rgba?\([^)]*\)/g, (m) => hex(m)); const t = s.split(/\s+/).filter(Boolean);
  const width = t.find((x) => /^\d/.test(x)) || '', style = t.find((x) => /^(none|solid|dashed|dotted|double|hidden)$/i.test(x)) || '', color = t.find((x) => x.startsWith('#')) || '';
  return (width && style ? `${width} ${style} ${color}`.trim() : s).toUpperCase(); };
const hex = (rgb) => { const m = rgb.match(/\d+(\.\d+)?/g); if (!m) return rgb; const [r, g, b] = m.map(Number); return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase(); };
const px = (v) => Math.round(parseFloat(v));
const fails = [];
const ok = (screen, state, sel, prop, want, got) => { if (String(want) !== String(got)) fails.push({ screen, state, sel, prop, want, got }); };

// 화면 상태 진입 — Alpine 상태를 직접 세팅한다. 구현 측에서 window.__rdState(screen, state) 를 제공하면 그것을 우선 쓴다.
// (예: __rdState('schedule','failed') → 실패 결과 픽스처 주입). 없으면 route 문자열을 Alpine 루트에서 eval.
async function enter(page, screen, state) {
  await page.evaluate(([screen, state, route]) => {
    if (window.__rdState) return window.__rdState(screen, state);
    const root = document.querySelector('[x-data]'); const a = window.Alpine && window.Alpine.$data(root);
    if (a && route) { new Function('a', `with(a){${route}}`)(a); }
    if (a && state) a.__rdDemoState = state;   // 구현 측이 데모 픽스처 스위치로 사용할 수 있음
  }, [screen, state, spec.screens[screen].route || null]);
  await page.waitForTimeout(400);
}

async function checkAsserts(page, screen, state, asserts) {
  for (const a of asserts) {
    const els = await page.$$(a.sel);
    if (a.exists === false) { ok(screen, state, a.sel, 'exists', false, els.length > 0); continue; }
    if ('count' in a) ok(screen, state, a.sel, 'count', a.count, els.length);
    if ('countAtLeast' in a) ok(screen, state, a.sel, 'countAtLeast', true, els.length >= a.countAtLeast);
    if ('iconOnlyCount' in a) { const n = (await Promise.all(els.map(e => e.innerText()))).filter(t => !t.trim()).length; ok(screen, state, a.sel, 'iconOnlyCount', a.iconOnlyCount, n); }
    if ('visibleRowsAtLeast' in a) {
      const n = await page.evaluate((sel) => { const wrap = document.querySelector('[data-rd=table-wrap]'); if (!wrap) return -1; const wr = wrap.getBoundingClientRect(); return [...document.querySelectorAll(sel)].filter(r => { const b = r.getBoundingClientRect(); return b.top >= wr.top && b.bottom <= wr.bottom; }).length; }, a.sel);
      ok(screen, state, a.sel, 'visibleRowsAtLeast', true, n >= a.visibleRowsAtLeast); continue;
    }
    if (!els.length) { if (a.exists !== false && !('count' in a)) fails.push({ screen, state, sel: a.sel, prop: 'exists', want: true, got: false }); continue; }
    const el = els[0];
    const cs = await el.evaluate(e => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return { h: r.height, w: r.width, minH: s.minHeight, fs: s.fontSize, fw: s.fontWeight, color: s.color, bg: s.backgroundColor, br: s.borderRadius, bb: s.borderBottom, bt: s.borderTop, bs: s.boxShadow, ol: s.outline, pos: s.position, ml: s.marginLeft, mr: s.marginRight, minW: s.minWidth, text: e.innerText, title: e.getAttribute('title') }; });
    if ('height' in a) ok(screen, state, a.sel, 'height', a.height, Math.round(cs.h));
    if ('minHeight' in a) ok(screen, state, a.sel, 'minHeight', true, Math.round(cs.h) >= a.minHeight);
    if ('width' in a) ok(screen, state, a.sel, 'width', a.width, Math.round(cs.w));
    if ('minWidth' in a) ok(screen, state, a.sel, 'minWidth', true, Math.round(cs.w) >= a.minWidth);
    if ('fontSize' in a) ok(screen, state, a.sel, 'fontSize', a.fontSize, px(cs.fs));
    if ('fontWeight' in a) ok(screen, state, a.sel, 'fontWeight', a.fontWeight, Number(cs.fw));
    if ('color' in a) ok(screen, state, a.sel, 'color', a.color.toUpperCase(), hex(cs.color));
    if ('background' in a) ok(screen, state, a.sel, 'background', a.background.toUpperCase(), hex(cs.bg));
    if ('borderRadius' in a) ok(screen, state, a.sel, 'borderRadius', typeof a.borderRadius === 'number' ? a.borderRadius + 'px' : a.borderRadius, cs.br);
    if ('borderBottom' in a) ok(screen, state, a.sel, 'borderBottom', shorthand(a.borderBottom), shorthand(cs.bb));
    if ('borderTop' in a) ok(screen, state, a.sel, 'borderTop', shorthand(a.borderTop), shorthand(cs.bt));
    if ('outline' in a) ok(screen, state, a.sel, 'outline', shorthand(a.outline), shorthand(cs.ol));
    if ('boxShadowIncludes' in a) ok(screen, state, a.sel, 'boxShadowIncludes', true, cs.bs.includes(a.boxShadowIncludes));
    if ('positionSticky' in a) ok(screen, state, a.sel, 'positionSticky', a.positionSticky, cs.pos === 'sticky');
    if ('marginLeft' in a) ok(screen, state, a.sel, 'marginLeft', a.marginLeft, px(cs.ml));
    if ('marginRight' in a) ok(screen, state, a.sel, 'marginRight', a.marginRight, px(cs.mr));
    if ('text' in a) ok(screen, state, a.sel, 'text', a.text, cs.text.trim());
    if ('textIncludes' in a) ok(screen, state, a.sel, 'textIncludes', true, cs.text.includes(a.textIncludes));
    if ('hasTitle' in a) ok(screen, state, a.sel, 'hasTitle', true, !!(cs.title && cs.title.trim()));
  }
}

async function checkGlobal(page, screen, state) {
  const g = spec.global;
  const r = await page.evaluate((g) => {
    const out = { small: [], bold: [], grey: [], target: [], iconOnly: [], noTitle: [], primary: 0, english: [] };
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const modal = document.querySelector('.rmodal-bg'); const scope = modal || document.body;
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let n; const seen = new Set();
    while ((n = walker.nextNode())) {
      const t = n.textContent.trim(); const e = n.parentElement; if (!t || !e || seen.has(e) || !vis(e)) continue; seen.add(e);
      const s = getComputedStyle(e); const fs = parseFloat(s.fontSize), fw = Number(s.fontWeight);
      if (fs < g.minFontSizePx && !e.closest('.rprint')) out.small.push(`${t.slice(0, 20)} ${fs}px`);
      if (fs < 22 && fw > g.maxFontWeightBelow22px) out.bold.push(`${t.slice(0, 20)} ${fw}`);
      const col = s.color.match(/\d+/g); if (col) { const hx = '#' + col.slice(0, 3).map(v => (+v).toString(16).padStart(2, '0')).join('').toUpperCase(); if (g.forbiddenTextColors.includes(hx) && !e.closest('[disabled],.is-disabled')) out.grey.push(`${t.slice(0, 20)} ${hx}`); }
      for (const w of g.englishLabelsForbidden) if (t === w || t.startsWith(w + ' ')) out.english.push(t.slice(0, 30));
    }
    for (const b of scope.querySelectorAll('button,[role=button],label.rcheck')) {
      if (!vis(b)) continue; const bb = b.getBoundingClientRect();
      if (bb.height < g.minClickTargetPx && !b.closest('td,.rpop-close,.rpop-grid')) out.target.push(`${(b.innerText || b.getAttribute('title') || '?').trim().slice(0, 20)} ${Math.round(bb.height)}px`);
      const allow = b.matches('[data-rd=ym-prev],[data-rd=ym-next],[data-rd=modal-close],[data-rd=popup-close],[data-rd=drawer-close],.rnum button,.rpop-close');
      if (b.tagName === 'BUTTON' && !b.innerText.trim() && !allow) out.iconOnly.push(b.outerHTML.slice(0, 80));
      if (b.tagName === 'BUTTON' && !b.getAttribute('title') && !allow) out.noTitle.push((b.innerText || b.outerHTML).trim().slice(0, 40));
      if (b.matches('.rbtn-primary')) out.primary++;
    }
    return out;
  }, g);
  for (const k of ['small', 'bold', 'grey', 'target', 'iconOnly', 'noTitle', 'english']) if (r[k].length) fails.push({ screen, state, sel: '(global)', prop: k, want: 0, got: r[k].length + ' → ' + r[k].slice(0, 4).join(' | ') });
  if (r.primary !== g.primaryPerScreen) fails.push({ screen, state, sel: '(global)', prop: 'primaryPerScreen', want: g.primaryPerScreen, got: r.primary });
}

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
for (const [screen, sc] of Object.entries(spec.screens)) {
  const vp = sc.viewport || spec.viewport;
  const page = await browser.newPage({ viewport: vp, deviceScaleFactor: 1 });
  await page.goto(URL, { waitUntil: 'networkidle' });
  await enter(page, screen, null);
  await checkAsserts(page, screen, '-', sc.asserts || []);
  await checkGlobal(page, screen, '-');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${screen}.png`) });
  for (const [state, st] of Object.entries(sc.states || {})) {
    await enter(page, screen, state);
    await checkAsserts(page, screen, state, st.asserts || []);
    await checkGlobal(page, screen, state);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${screen}-${state}.png`) });
  }
  await page.close();
}
await browser.close();

if (fails.length) {
  console.log(`\n✗ ${fails.length} 항목 불일치\n`);
  console.table(fails.map(f => ({ screen: f.screen, state: f.state, selector: f.sel, prop: f.prop, expected: f.want, actual: f.got })));
  process.exit(1);
}
console.log('✓ spec.json 전 항목 일치. reference/*.png 와 --shots 결과를 나란히 놓고 눈으로 최종 확인할 것.');
