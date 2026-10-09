// 병동별 예시 데이터 파일 — node scripts/make-assign-examples.mjs [--check]
//
// standalone/예시/<병동>병동 예시.js 를 assign.html 의 makeExample() 로 만든다 (병동 14개).
// 가상의 간호사(옛이야기 이름)·근무표 5주·당직표(010-0000-…)·교육 일정이 들어 있고, 파일에 예시 표시(example)가 있어
// assign.html 에 끌어다 놓거나 [데이터 파일 열기]로 열면 **예시로** 열린다 — 고친 것이 이 파일에 쌓이지 않는다.
// 화면의 [예시로 둘러보기]도 같은 함수로 만들고 날짜만 이번 주로 옮긴다.
//
//   (인자 없음)  파일을 다시 만든다 — makeExample 이나 서식·병실 규칙을 바꿨으면 돌리고 커밋한다
//   --check      지금 assign.html 로 만든 것과 커밋된 파일이 같은지 + 파일마다 예시로 열어
//                5주 모두 '확인 필요'가 없고 엑셀·인쇄·하루 어싸인표가 나오는지 (CI)
//
// 크롬 경로: $CHROME → google-chrome → chromium → macOS Google Chrome 순.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'standalone/예시');
const START = '2026-10-04';            // 파일의 '이번 주' (일요일) — 근무표는 그 전 주부터 5주
const CHECK = process.argv.includes('--check');
const fileOf = w => `${w}병동 예시.js`;
const iso = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const addD = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
// 예시를 열면 보이는 주 — 이번 주가 예시 근무표 안이면 이번 주, 아니면 예시의 첫 주(START)
function firstWeek() {
  const t = new Date(); t.setHours(0, 0, 0, 0); t.setDate(t.getDate() - t.getDay());
  const now = iso(t);
  return now >= addD(START, -7) && addD(now, 6) <= addD(START, 27) ? now : START;
}

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { execSync(`command -v ${c}`, { stdio: 'ignore' }); return c; } catch { /* 다음 후보 */ }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(mac) ? mac : null;
}
const CHROME = findChrome();
if (!CHROME) { console.log('SKIP  크롬을 찾지 못했습니다 ($CHROME 로 지정하세요)'); process.exit(CHECK ? 0 : 1); }
if (typeof WebSocket === 'undefined') {
  console.log(`SKIP  이 Node 에는 전역 WebSocket 이 없습니다 (${process.version}, 22 이상 필요)`);
  process.exit(CHECK ? 0 : 1);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 리포 폴더에는 개발자의 assign-data.js 가 있을 수 있다 — 빈 폴더의 사본으로 띄운다
const WORK = mkdtempSync(join(tmpdir(), 'assign-examples-'));
copyFileSync(resolve(ROOT, 'standalone/assign.html'), join(WORK, 'assign.html'));
const port = 9900 + (process.pid % 90);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu',
  '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--allow-file-access-from-files',
  '--window-size=1920,1080', `--user-data-dir=${join(WORK, 'profile')}`, 'about:blank'], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map(), errors = [];
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
});
let STEP = '(시작 전)';
async function ev(expr, ms = 30000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `window.__evKeep=(async()=>{${expr}})()`, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error(`${ms}ms 안에 응답 없음 — ${STEP}`); })]);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception || {};
    throw new Error((e.description || e.value || JSON.stringify(r.exceptionDetails)) + ` — ${STEP}`);
  }
  return r.result.value;
}

const fails = [];
async function main() {
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = JSON.parse(execSync(`curl -s --noproxy '*' http://127.0.0.1:${port}/json`).toString());
      target = list.find(t => t.type === 'page');
    } catch { /* 아직 안 떴다 */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('크롬 디버깅 포트에 붙지 못했습니다');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', m => {
    const d = JSON.parse(m.data); const p = pending.get(d.id);
    if (p) { pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
    if (d.method === 'Runtime.exceptionThrown') {
      const x = d.params.exceptionDetails; errors.push((x.exception && x.exception.description) || x.text);
    }
    if (d.method === 'Page.javascriptDialogOpening')
      ws.send(JSON.stringify({ id: 1e6 + (++seq), method: 'Page.handleJavaScriptDialog', params: { accept: true } }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'file://' + encodeURI(join(WORK, 'assign.html')) });
  for (let i = 0; i < 80; i++) {
    try { if (await ev('return !!(window.__app && window.__app.makeExample)')) break; } catch { /* 아직 로드 중 */ }
    await sleep(250);
  }
  await sleep(800);

  STEP = '예시 만들기';
  const made = await ev(`const A=window.__app; const out={};
    for(const w of A.WARDS) out[w]=A.serializeStore(A.makeExample(w,{start:${JSON.stringify(START)}}));
    return out;`);
  const wards = Object.keys(made);
  if (wards.length !== 14) fails.push(`병동 수가 14가 아닙니다: ${wards.length}`);

  if (!CHECK) {
    mkdirSync(OUT, { recursive: true });
    for (const f of readdirSync(OUT)) if (/병동 예시\.js$/.test(f) && !wards.some(w => fileOf(w) === f)) rmSync(join(OUT, f));
    for (const w of wards) writeFileSync(join(OUT, fileOf(w)), made[w]);
    console.log(`예시 파일 ${wards.length}개를 만들었습니다 — standalone/예시/`);
    return;
  }

  // 커밋된 파일 = 지금 HTML 이 만든 것
  for (const w of wards) {
    const p = join(OUT, fileOf(w));
    if (!existsSync(p)) { fails.push(`${fileOf(w)} 없음 — node scripts/make-assign-examples.mjs 를 돌리고 커밋하세요`); continue; }
    if (readFileSync(p, 'utf8') !== made[w])
      fails.push(`${fileOf(w)} 가 지금 assign.html 의 makeExample 과 다릅니다 — node scripts/make-assign-examples.mjs 를 돌리고 커밋하세요`);
  }
  const extra = existsSync(OUT) ? readdirSync(OUT).filter(f => /\.js$/.test(f) && !wards.some(w => fileOf(w) === f)) : [];
  if (extra.length) fails.push('남는 예시 파일: ' + extra.join(', '));

  // 파일마다 예시로 열어 5주를 넘겨 본다
  for (const w of wards) {
    STEP = `${w}병동 예시 열기`;
    const r = await ev(`const A=window.__app;
      const txt=${JSON.stringify(made[w])};
      await A.enterDemo(A.parseStoreText(txt));
      const out={demo:A.inDemo(),pill:document.querySelector('#fileInfo').textContent.trim(),sun:A.isoOfD(A.wkSunday),weeks:[],
        ward:A.store.ward,form:A.formId(),n:A.store.order.length};
      const s0=new Date(${JSON.stringify(START)}+'T00:00:00');
      for(let k=-1;k<4;k++){ const d=new Date(s0); d.setDate(d.getDate()+7*k); A.wkSunday=d; A.renderWeek();
        const wb=document.querySelector('#wkWarn'), t=wb&&wb.style.display!=='none'?wb.innerText.replace(/\\s+/g,' '):'';
        const {tpl,xml}=await A.buildWeekXlsx(d); await A.packWeekXlsx(tpl,xml,d);
        if(A.canPrint()) A.buildPrintArea();
        out.weeks.push({sun:A.isoOfD(d),err:t.includes('확인 필요')?t.slice(0,300):''}); }
      const h=await A.dayHwpxBytes(${JSON.stringify(START)}); out.hwpx=h&&h.length>1000;
      A.show('week'); A.leaveDemo();
      out.after=[A.inDemo(),A.store.order.length];
      return out;`, 60000);
    const bad = [];
    if (!r.demo) bad.push('예시로 열리지 않음');
    if (r.pill !== '예시 · 저장 안 됨') bad.push('머리줄 알약: ' + r.pill);
    if (r.sun !== firstWeek()) bad.push(`첫 화면 주: ${r.sun} (기대 ${firstWeek()})`);
    if (r.ward !== w) bad.push('병동: ' + r.ward);
    for (const x of r.weeks) if (x.err) bad.push(`${x.sun} 주 확인 필요 — ${x.err}`);
    if (!r.hwpx) bad.push('하루 어싸인표(hwpx)가 안 나옴');
    if (r.after[0] || r.after[1]) bad.push('예시를 끝낸 뒤에도 남음: ' + JSON.stringify(r.after));
    if (bad.length) fails.push(`${w}병동: ` + bad.join(' / '));
    else console.log(`  ok  ${fileOf(w)} — ${r.form} 서식 · 간호사 ${r.n}명 · 5주 확인 필요 없음`);
  }
  if (errors.length) fails.push('페이지 오류: ' + errors.slice(0, 3).join(' | '));
}

let code = 0;
try { await main(); } catch (e) { fails.push('하네스: ' + e.message); }
try { ws && ws.close(); } catch { /* 이미 닫힘 */ }
chrome.kill();
setTimeout(() => { try { rmSync(WORK, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 임시 폴더 */ } }, 1000);
if (fails.length) {
  console.log(`예시 파일: ${fails.length}건 실패`);
  for (const f of fails) console.log('  FAIL  ' + f);
  code = 1;
} else if (CHECK) console.log('예시 파일: 14개 모두 지금 assign.html 과 같고 예시로 깨끗하게 열립니다');
setTimeout(() => process.exit(code), 1200);
