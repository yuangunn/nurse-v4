// assign.html 데이터 파일 호환 — node scripts/test_assign_compat.mjs
//
// 병동은 assign.html 만 새 것으로 바꾸고 데이터 파일(assign-data.js)은 그대로 쓴다.
// 그래서 **배포했던 버전이 만든 데이터 파일**을 지금 assign.html 옆에 두고 열어 본다.
//
//   tests/fixtures/assign-data/<버전>.js           배포본이 저장한 데이터 파일 (가명)
//   tests/fixtures/assign-data/<버전>.expect.json  그 배포본이 같은 파일로 낸 어싸인 결과
//
// 확인하는 것 (하나라도 어긋나면 실패):
//   · 옆 파일이 자동으로 열리고 페이지 오류가 없다
//   · 근무표·명부·가능 근무·표기·신규·전출·병실·방 구성·프리셋·양식·원칙이 그대로다
//   · 날짜별 교육·행사 글이 같은 날에 그대로 나온다 (옛 events → 새 일정 규칙)
//   · 관리 화면 전부·주간 엑셀·인쇄·하루 어싸인표가 그 파일로 돌아간다
//   · 새 버전이 저장한 파일을 다시 열어도 같다 (옮기기를 두 번 해도 안 바뀐다)
//   · 저장 연결을 기억하는 곳(IndexedDB 'assignApp'·'handle')이 같다 — 바뀌면 병동이 파일을 다시 골라야 한다
// 안내만 하는 것: 같은 근무표로 낸 어싸인이 배포본과 다르면 몇 칸인지 알려 준다 (의도한 원칙 변경일 수 있다).
//
// 배포할 때마다 그 배포본으로 새 고정 파일을 하나 더 만든다:
//   node scripts/test_assign_compat.mjs --make <커밋>     (예: --make 2c79c7b)
// 그 커밋의 standalone/assign.html 을 띄워 아래 SCENARIO 대로 데이터를 넣고 저장본을 떠 둔다.
//
// 크롬 경로: $CHROME → google-chrome → chromium → macOS Google Chrome 순.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = resolve(ROOT, 'tests/fixtures/assign-data');
const CUR = resolve(ROOT, 'standalone/assign.html');

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { execSync(`command -v ${c}`, { stdio: 'ignore' }); return c; } catch { /* 다음 후보 */ }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  return existsSync(mac) ? mac : null;
}
const CHROME = findChrome();
if (!CHROME) { console.log('SKIP  크롬을 찾지 못했습니다 ($CHROME 로 지정하세요)'); process.exit(0); }
if (typeof WebSocket === 'undefined') {
  console.log(`SKIP  이 Node 에는 전역 WebSocket 이 없습니다 (${process.version}, 22 이상 필요)`);
  process.exit(0);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** html 을 빈 폴더에 복사하고 (있으면) 데이터 파일을 옆에 둔 채 띄운다. */
async function openPage(htmlText, sidecar) {
  const dir = mkdtempSync(join(tmpdir(), 'assign-compat-'));
  writeFileSync(join(dir, 'assign.html'), htmlText);
  if (sidecar) writeFileSync(join(dir, 'assign-data.js'), sidecar);
  const port = 9600 + Math.floor(Math.random() * 300);
  const page = 'file://' + encodeURI(join(dir, 'assign.html'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu',
    '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--allow-file-access-from-files',
    '--window-size=1920,1080', `--user-data-dir=${join(dir, 'profile')}`, 'about:blank'], { stdio: 'ignore' });
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = JSON.parse(execSync(`curl -s --noproxy '*' http://127.0.0.1:${port}/json`).toString());
      target = list.find(t => t.type === 'page');
    } catch { /* 아직 안 떴다 */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('크롬 디버깅 포트에 붙지 못했습니다');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let seq = 0; const pending = new Map(); const errors = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const id = ++seq; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params }));
  });
  ws.addEventListener('message', m => {
    const d = JSON.parse(m.data); const p = pending.get(d.id);
    if (p) { pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
    if (d.method === 'Runtime.exceptionThrown') {
      const x = d.params.exceptionDetails; errors.push((x.exception && x.exception.description) || x.text);
    }
    if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error')
      errors.push('console.error: ' + d.params.args.map(a => a.value ?? a.description).join(' '));
    // 대화상자가 뜨면 평가가 영원히 안 돌아온다 — 받아 넘긴다
    if (d.method === 'Page.javascriptDialogOpening')
      ws.send(JSON.stringify({ id: 1e6 + (++seq), method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: '회진일' } }));
  });
  await send('Runtime.enable'); await send('Page.enable');
  // 대화상자는 페이지 스크립트보다 먼저 막는다 — 부팅 중 확인창이 떠도 멈추지 않게
  await send('Page.addScriptToEvaluateOnNewDocument', { source:
    "window.confirm=()=>true;window.alert=()=>{};window.prompt=()=>'회진일';" });
  await send('Page.navigate', { url: page });
  let STEP = '(시작 전)';
  const ev = async (expr, ms = 20000) => {
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: `window.__evKeep=(async()=>{${expr}})()`, returnByValue: true, awaitPromise: true }),
      sleep(ms).then(() => { throw new Error(`${ms}ms 안에 응답 없음 — ${STEP}`); })]);
    if (r.exceptionDetails) {
      const e = r.exceptionDetails.exception || {};
      throw new Error((e.description || e.value || JSON.stringify(r.exceptionDetails)) + ` — ${STEP}`);
    }
    return r.result.value;
  };
  for (let i = 0; i < 80; i++) {
    try { if (await ev('return !!(window.__app && window.__app.store)')) break; } catch { /* 아직 로드 중 */ }
    await sleep(250);
  }
  await sleep(1500);   // 옆 파일 자동 열기(스크립트 태그 로드)가 끝나기를 기다린다
  return {
    ev, errors, step: s => { STEP = s; },
    close() { try { ws.close(); } catch { /* 이미 닫힘 */ } chrome.kill();
      // 크롬이 프로필을 다 내려놓기 전에 지우면 ENOTEMPTY — 조금 기다렸다 지우고, 못 지워도 검사는 계속한다
      setTimeout(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 임시 폴더 */ } }, 1000); },
  };
}

const dataOf = t => JSON.parse(t.slice(t.indexOf('=') + 1, t.lastIndexOf(';')));
const verOf = html => (html.match(/v2\d{5}[a-z]*/) || [])[0];

/* ── 고정 파일 만들기: 배포본에 넣을 데이터 ────────────────────────────────
 * 가명 17명 · 9월 · 92병동 · 122 서식. 병동이 실제로 만지는 것을 두루 넣는다.
 * 배포본마다 같은 시나리오를 돌려야 비교가 된다 — 고칠 때는 새 고정 파일만 새 시나리오로. */
const NAMES = ['홍길동', '김영숙', '이서준', '박지민', '최하늘', '정다운', '강민호', '조은비',
  '윤서연', '장하준', '임수아', '한도윤', '오지우', '서예린', '신유나', '권태오'];
function scenarioGrid() {
  const days = []; for (let d = 1; d <= 30; d++) days.push('9/' + d);
  const pat = ['D', 'D', 'E', 'E', 'N', 'N', 'OF', 'OF', 'D', 'E', 'OF', 'D', 'E', 'N', 'OF', '주'];
  const g = [['이름', ...days], ...NAMES.map((n, i) => [n, ...days.map((_, d) => pat[(i + d * 3) % pat.length])])];
  g.push(['신규일', ...days.map((_, d) => ['/D', '/E', 'OF'][d % 3])]);
  return g;
}
async function make(ref) {
  const html = execSync(`git show ${ref}:standalone/assign.html`, { cwd: ROOT, maxBuffer: 64 << 20 }).toString();
  const ver = verOf(html);
  if (!ver) throw new Error(`${ref} 의 assign.html 에서 버전을 못 읽었습니다`);
  const p = await openPage(html);
  try {
    await p.ev(`const A=window.__app; A.memoryMode(); await new Promise(r=>setTimeout(r,300));
      A.setWard('92');
      A.ingestGrid(${JSON.stringify(scenarioGrid())}); A.confirmPaste();
      const s=A.store;
      s.events['2026-09-15']='CPR 교육 14:00'; s.events['2026-09-22']='감염 교육\\n2층';
      s.caps['한도윤']=['D','E','N']; s.hidden['권태오']=true;
      s.custom['필']='휴가'; s.alias['VAC']='V';
      s.trainee['신규일']={pre:'홍길동'};
      A.addPreset(4);
      s.rooms[0][1]=3;
      A.setFormId('122');
      A.recompute(); return 1`, 60000);
    const data = await p.ev(`return 'window.__ASSIGN_DATA='+JSON.stringify(window.__app.store)+';\\n'`);
    const result = await p.ev('return window.__app.result');
    if (p.errors.length) throw new Error('배포본이 오류를 냈습니다: ' + p.errors.join(' | '));
    mkdirSync(FIX, { recursive: true });
    writeFileSync(join(FIX, ver + '.js'), data);
    writeFileSync(join(FIX, ver + '.expect.json'), JSON.stringify({ ver, madeFrom: ref, result }) + '\n');
    console.log(`만듦  tests/fixtures/assign-data/${ver}.js (${ref})`);
  } finally { p.close(); }
}

/* ── 검사 ─────────────────────────────────────────────────────────────── */
let pass = 0; const fails = []; const notes = [];
const ok = (name, cond, detail = '') => { if (cond) pass++; else fails.push(name + (detail ? '\n      ' + detail : '')); };
const same = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  `받음 ${JSON.stringify(got)?.slice(0, 300)}\n      기대 ${JSON.stringify(want)?.slice(0, 300)}`);

// 옛 파일의 값이 새 버전에서도 그대로여야 하는 칸 — 새 버전이 옮기는 칸(req·events·form)은 따로 본다
const KEEP = ['order', 'cells', 'ovr', 'roomOv', 'seedManual', 'caps', 'alias', 'custom', 'nameAlias',
  'trainee', 'trOv', 'rooms', 'ward', 'wardPicked', 'banRooms', 'formId', 'forms', 'presetPlan', 'presetDay',
  'ovrPair', 'hidden', 'rules'];

async function check(file, html) {
  const tag = file.replace(/\.js$/, '');
  const oldText = readFileSync(join(FIX, file), 'utf8');
  const old = dataOf(oldText);
  const expect = existsSync(join(FIX, tag + '.expect.json')) ? JSON.parse(readFileSync(join(FIX, tag + '.expect.json'), 'utf8')) : null;
  const p = await openPage(html, oldText);
  let saved;
  try {
    p.step(`${tag} 열기`);
    const st = await p.ev(`const A=window.__app; return {kind:A.fileLoc.kind, store:A.store}`);
    same(`${tag}: 옆 데이터 파일이 자동으로 열린다`, st.kind, 'sidecar');
    for (const k of KEEP) if (k in old) same(`${tag}: ${k} 가 그대로다`, st.store[k], old[k]);
    for (const c in old.schemes || {}) same(`${tag}: ${c}인 방 구성이 그대로다`, st.store.schemes[c], old.schemes[c]);
    for (const c in old.presets || {}) same(`${tag}: ${c}인 프리셋이 그대로다`, st.store.presets[c], old.presets[c]);

    p.step(`${tag} 교육·행사`);
    const evs = old.events || {};
    const got = await p.ev(`const A=window.__app; return ${JSON.stringify(Object.keys(evs))}.map(iso=>A.eventText(iso))`);
    Object.values(evs).forEach((t, i) => same(`${tag}: ${Object.keys(evs)[i]} 교육·행사 글이 그대로 나온다`, got[i], t));

    p.step(`${tag} 어싸인`);
    const result = await p.ev('const A=window.__app; A.recompute(); return A.result');
    ok(`${tag}: 어싸인을 계산한다`, !!result);
    if (expect && result) {
      const flat = (o, pre = '', out = {}) => { for (const k in o || {}) { const v = o[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) flat(v, pre + k + '/', out); else out[pre + k] = JSON.stringify(v); } return out; };
      const a = flat(expect.result), b = flat(result);
      // 누가 차지인지(…/charge)는 2026-10-01 부터 결과에 새로 실린다 — 자리(labels)가 같으면 같은 어싸인이다
      const diff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k] && !/[/]charge$/.test(k));
      if (diff.length) notes.push(`${tag}: 같은 근무표로 낸 어싸인이 배포본과 ${diff.length}칸 다릅니다 — 원칙을 바꾼 게 아니면 확인하세요 (예: ${diff.slice(0, 3).join(', ')})`);
    }

    p.step(`${tag} 화면`);
    const panels = await p.ev(`const A=window.__app; A.show('admin'); const bad=[];
      for(const id of Object.keys(A.ADMIN_PANELS)){ try{ A.pickAdmin(id); }catch(e){ bad.push(id+': '+e.message); } }
      A.show('week'); return bad`);
    same(`${tag}: 관리 화면이 모두 열린다`, panels, []);
    const out = await p.ev(`const A=window.__app; const iso=Object.keys(A.store.cells[A.store.order[0]]||{}).sort()[0];
      const [y,m,d]=iso.split('-').map(Number); const day=new Date(y,m-1,d); const sun=new Date(y,m-1,d-day.getDay());
      A.wkSunday=sun; A.show('week'); A.renderWeek();
      const {tpl,xml}=await A.buildWeekXlsx(sun); await A.packWeekXlsx(tpl,xml,sun);
      if(A.canPrint()) A.buildPrintArea();
      A.openDay(iso); await new Promise(r=>setTimeout(r,800));
      const h=await A.dayHwpxBytes(iso); A.show('week');
      return {cells:document.querySelectorAll('#scrWeek td').length, hwpx:h&&h.length}`, 60000);
    ok(`${tag}: 배정표가 그려진다`, out.cells > 50, `칸 ${out.cells}`);
    ok(`${tag}: 하루 어싸인표 한글 파일이 만들어진다`, out.hwpx > 1000, `바이트 ${out.hwpx}`);
    same(`${tag}: 페이지 오류가 없다`, p.errors, []);
    saved = await p.ev(`const A=window.__app; return {text:'window.__ASSIGN_DATA='+JSON.stringify(A.store)+';\\n', store:A.store}`);
  } finally { p.close(); }

  // 새 버전이 저장한 파일을 다시 연다 — 옮기기를 두 번 해도 안 바뀌어야 한다
  const q = await openPage(html, saved.text);
  try {
    q.step(`${tag} 다시 열기`);
    const again = await q.ev('return window.__app.store');
    const strip = s => { const o = { ...s }; delete o.rev; delete o.saved; delete o.ui; return o; };
    same(`${tag}: 새 버전이 저장한 파일을 다시 열어도 같다`, strip(again), strip(saved.store));
    same(`${tag}: 다시 열 때 페이지 오류가 없다`, q.errors, []);
  } finally { q.close(); }
}

async function main() {
  const i = process.argv.indexOf('--make');
  if (i > 0) { await make(process.argv[i + 1] || 'HEAD'); return; }
  const html = readFileSync(CUR, 'utf8');
  // 저장 연결(파일 핸들)은 IndexedDB 에 기억한다 — 이름이 바뀌면 병동마다 파일을 다시 골라야 한다
  ok("저장 연결 기억 장소가 그대로다 (IndexedDB 'assignApp' v1)", html.includes("indexedDB.open('assignApp',1)"));
  ok("저장 연결 기억 키가 그대로다 ('handle')", html.includes("idbGet('handle')"));
  const files = existsSync(FIX) ? readdirSync(FIX).filter(f => f.endsWith('.js')).sort() : [];
  ok('옛 데이터 파일이 하나 이상 있다', files.length > 0, 'tests/fixtures/assign-data/ 가 비었습니다');
  for (const f of files) await check(f, html);
}

main().then(() => {
  for (const n of notes) console.log('안내  ' + n);
  if (fails.length) {
    console.log(`\nFAIL  데이터 파일 호환 ${fails.length}건 (통과 ${pass})`);
    for (const f of fails) console.log('  ✗ ' + f);
    process.exit(1);
  }
  if (!process.argv.includes('--make')) console.log(`ok    데이터 파일 호환 ${pass}건 통과`);
  process.exit(0);
}).catch(e => { console.error('FAIL  ' + (e.stack || e.message)); process.exit(1); });
