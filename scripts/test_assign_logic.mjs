// standalone/assign.html 계산 로직 회귀 — node scripts/test_assign_logic.mjs
//
// 화면·문구는 보지 않는다. 병상 토큰·병실/병동 규칙·프리셋·서식 인식·붙여넣기처럼
// **바꾸면 조용히 깨지는 계산**만 확인한다. 화면 단언을 넣으면 화면을 고칠 때마다
// 기대값을 같이 고쳐야 해서 곧 주석 처리되고 만다 (2026-09 스크래치 12종이 그랬다).
//
// 왜 헤드리스인가: 이 로직들은 4,900줄 단일 HTML 안에 있고 DOM 에 붙어 있다.
// 뽑아내려면 큰 리팩터가 필요하고, 그건 단일 파일 배포라는 전제를 깬다.
// 그래서 실제로 띄우고 window.__app 훅으로 함수만 두드린다.
//
// 크롬 경로: $CHROME → google-chrome → chromium → macOS Google Chrome 순.
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// 리포 폴더에는 개발자의 assign-data.js 가 있을 수 있고, 페이지는 옆에 있는 그 파일을
// 자동으로 읽어 store 를 덮어쓴다 — 그러면 로컬과 CI 결과가 갈린다.
// 사이드카가 없는 빈 폴더에 사본을 두고 띄운다.
const WORK = mkdtempSync(join(tmpdir(), 'assign-logic-'));
copyFileSync(resolve(ROOT, 'standalone/assign.html'), join(WORK, 'assign.html'));
const PAGE = 'file://' + encodeURI(join(WORK, 'assign.html'));
const PORT = 9411 + (process.pid % 200);

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try { execSync(`command -v ${c}`, { stdio: 'ignore' }); return c; } catch { /* 다음 후보 */ }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  return null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.log('SKIP  크롬을 찾지 못했습니다 ($CHROME 로 지정하세요)');
  process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run',
  '--no-default-browser-check', '--no-sandbox', '--allow-file-access-from-files',
  `--user-data-dir=${process.env.TMPDIR || '/tmp'}/assign-logic-${process.pid}`, PAGE,
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});

let STEP = '(시작 전)';
const step = s => { STEP = s; if (process.env.VERBOSE) console.log('  · ' + s); };

/** 페이지 안에서 식을 평가하고 값을 가져온다. 예외·무응답은 그대로 던진다.
 *  awaitPromise 는 약속이 영원히 안 풀리면 CDP 가 응답을 안 준다 — 자체 타임아웃 필수. */
async function ev(expr, ms = 20000) {
  const call = send('Runtime.evaluate', {
    expression: `(()=>{${expr}})()`, returnByValue: true, awaitPromise: true,
  });
  const r = await Promise.race([
    call,
    sleep(ms).then(() => { throw new Error(`${ms}ms 안에 응답 없음 — ${STEP}`); }),
  ]);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception || {};
    throw new Error((e.description || e.value || JSON.stringify(r.exceptionDetails)) + ` — ${STEP}`);
  }
  return r.result.value;
}

let pass = 0;
const fails = [];
const eq = (name, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; return; }
  fails.push(`${name}\n      받음 ${a}\n      기대 ${b}`);
};
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? '\n      ' + detail : ''}`);
};

async function main() {
  // ── 붙기 ──
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try {
      const list = JSON.parse(execSync(`curl -s http://127.0.0.1:${PORT}/json`).toString());
      target = list.find(t => t.type === 'page' && t.url.includes('assign.html'));
    } catch { /* 아직 안 떴다 */ }
    if (!target) await sleep(250);
  }
  if (!target) throw new Error('크롬 디버깅 포트에 붙지 못했습니다');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', m => {
    const d = JSON.parse(m.data); const p = pending.get(d.id);
    if (p) { pending.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
  });
  await send('Runtime.enable');

  for (let i = 0; i < 60; i++) {
    if (await ev('return !!(window.__app && window.__app.splitBed)')) break;
    await sleep(250);
  }
  step('훅 준비');
  ok('훅이 준비된다', await ev('return !!window.__app'));
  // confirm/alert/prompt 를 막는다 — setWard 처럼 확인창을 띄우는 함수가 있고,
  // 헤드리스에서 대화상자가 뜨면 CDP 평가가 영원히 안 돌아온다.
  await ev(`window.confirm=()=>true; window.alert=()=>{}; window.prompt=()=>null;
    window.__pageErrors=[]; window.addEventListener('error',e=>window.__pageErrors.push(String(e.message)));
    return 1`);
  await ev('window.__app.memoryMode(); return 1');

  step('1 병상 토큰');
  // ── 1. 병상 토큰 ────────────────────────────────────────────────────────
  // 방 토큰과 병상 토큰이 섞이면 코어가 "같은 환자"를 못 알아본다 (겹침 0).
  // roomsForCore 가 늘 병상 키로 펼쳐 넘기는 전제가 이 함수들 위에 서 있다.
  eq('병상 토큰 분해', await ev('const A=window.__app; return A.splitBed("1001:3")'), ['1001', 3]);
  eq('방만 있으면 병상 자리는 빈값', await ev('const A=window.__app; return A.splitBed("1001")'), ['1001', null]);
  eq('병상 토큰 조립', await ev('const A=window.__app; return A.bedTok("1001",2)'), '1001:2');

  await ev(`const A=window.__app, s=A.store;
    s.ward='101'; s.rooms=[['1001',5],['1002',4],['1003',1]]; A.store=s; return 1`);
  eq('방 → 병상 키', await ev('const A=window.__app; return A.bedKeys("1002")'),
    ['1002:1', '1002:2', '1003'.slice(0, 0) + '1002:3', '1002:4']);
  eq('1인실은 방 그대로', await ev('const A=window.__app; return A.bedKeys("1003")'), ['1003']);
  eq('펼치기', await ev('const A=window.__app; return A.expandBeds(["1001:1","1002"])'),
    ['1001:1', '1002:1', '1002:2', '1002:3', '1002:4']);
  eq('다 찬 방은 접힌다', await ev('const A=window.__app; return A.collapseBeds(A.expandBeds(["1002"]))'), ['1002']);
  eq('일부만이면 안 접힌다',
    await ev('const A=window.__app; return A.collapseBeds(["1002:1","1002:2"])'), ['1002:1', '1002:2']);

  // 범위 표기 — 손으로 "4:1~3" 이라 적는 병동이 있다
  eq('범위 읽기', await ev('const A=window.__app; return A.roomTokens("1:1~3")'), ['1:1', '1:2', '1:3']);
  eq('방 범위 읽기', await ev('const A=window.__app; return A.roomTokens("1~3")'), ['1', '2', '3']);

  step('2 병실·병동');
  // ── 2. 병실·병동 규칙 ───────────────────────────────────────────────────
  // 병동 = 층 + 라인, 병실 = 층×100 + (1라인 1~14 / 2라인 51~64).
  eq('92병동 병실', await ev('const A=window.__app; const r=A.wardRooms("92"); return [r.length, r[0], r[13]]'),
    [14, '951', '964']);
  eq('101병동 병실', await ev('const A=window.__app; const r=A.wardRooms("101"); return [r[0], r[13]]'),
    ['1001', '1014']);
  ok('1라인 3호와 2라인 53호는 같은 자리',
    await ev('const A=window.__app; return A.roomPos("1003")===A.roomPos("953")'));

  step('3 프리셋');
  // ── 3. 프리셋 ───────────────────────────────────────────────────────────
  // 기본 프리셋이 병실을 하나라도 빠뜨리면 그 방 환자를 아무도 안 본다.
  await ev(`const A=window.__app; A.setWard('101'); return 1`);
  ok('병동을 고르면 병실이 14개', await ev('const A=window.__app; return A.store.rooms.length===14'),
    await ev('const A=window.__app; return JSON.stringify(A.store.rooms.map(r=>r[0]))'));
  // presetAudit(preset) — 인원수별 기본 프리셋이 병실을 하나도 빠뜨리지 않아야 한다.
  // 실제로 2026-09-17 조사에서 기본 프리셋이 13번 방을 빠뜨려 92병동 963호를
  // 아무도 안 보는 상태가 나왔다.
  const audit = await ev(`const A=window.__app; const out={};
    for(const c of [2,3,4,5]){ const ps=A.presetsOf(c)||[];
      out[c]=ps.length?(()=>{const a=A.presetAudit(ps[0]);
        return {miss:a.missing.length, dup:a.dup.length};})():null; }
    return out;`);
  for (const c of [2, 3, 4, 5]) {
    ok(`${c}인 기본 프리셋이 모든 병실을 덮는다`,
      audit[c] && audit[c].miss === 0 && audit[c].dup === 0, JSON.stringify(audit[c]));
  }

  // 방을 하나 빼면 검사가 그것을 잡아야 한다 (검사가 늘 0을 주면 의미가 없다)
  const detect = await ev(`const A=window.__app;
    const p=JSON.parse(JSON.stringify(A.presetsOf(5)[0]));
    const l=Object.keys(p.rooms)[0]; p.rooms[l]=(p.rooms[l]||[]).slice(1);
    return A.presetAudit(p).missing.length;`);
  ok('방을 빼면 검사가 잡는다', detect > 0, String(detect));

  step('4 서식');
  // ── 4. 서식 101 / 122 ───────────────────────────────────────────────────
  // 자리 이름이 서식마다 다르다 — 화면·픽커·인쇄·xlsx 가 전부 FORM_LBL 하나를 본다.
  eq('101 자리 이름', await ev(`const A=window.__app; A.setFormId('101');
    return ['차지','A','B'].map(l=>A.FORM_LBL(l,'D'))`), ['A(CN)', 'B', 'C']);
  eq('122 자리 이름', await ev(`const A=window.__app; A.setFormId('122');
    return ['차지','A','B'].map(l=>A.FORM_LBL(l,'D'))`), ['CN', 'A', 'B']);
  await ev(`const A=window.__app; A.setFormId('101'); return 1`);

  const lay = await ev(`const A=window.__app;
    return (async()=>{ const t=await A.loadBaseTemplate('101');
      const L=A.findLayout(A.sheetCells(t), A.sheetMerges(t));
      return {days:(L.dateCols||[]).length, wd:!!L.wdRow, secs:(L.sections||[]).length};
    })()`);
  ok('101 양식 구조 인식 (7일·요일줄·D/E/N 3구역)',
    lay.days === 7 && lay.wd && lay.secs === 3, JSON.stringify(lay));

  const lay122 = await ev(`const A=window.__app;
    return (async()=>{ const t=await A.loadBaseTemplate('122');
      const L=A.findLayout122(A.sheetCells(t), A.sheetMerges(t));
      return {days:(L.wdCols||[]).length, rooms:(L.roomCols||[]).length,
              memo:(L.memoCols||[]).length, secs:(L.sections||[]).length};
    })()`);
  ok('122 양식 구조 인식 (요일 7칸 · 방 열 3개[일/월~금/토] · D/E/N 3구역)',
    lay122.days === 7 && lay122.rooms === 3 && lay122.memo === 7 && lay122.secs === 3,
    JSON.stringify(lay122));

  step('5 붙여넣기');
  // ── 5. 붙여넣기 ─────────────────────────────────────────────────────────
  // 제목 줄·요일 줄이 위에 있는 표를 첫 줄 고정으로 읽으면 통째로 오독한다.
  const paste = await ev(`const A=window.__app;
    A.ingestGrid([
      ['2026년 9월 근무표','','','',''],
      ['이름','9/1','9/2','9/3','9/4'],
      ['','화','수','목','금'],
      ['홍길동','D','D','E','N'],
      ['김영숙','E','N','OF','D'],
    ]);
    const p=window.__pendingForTest||null;
    const cells=document.querySelectorAll('#pvWrap td').length;
    return {preview:document.querySelector('#pvCard').style.display!=='none', cells};`);
  ok('제목 줄·요일 줄이 있어도 표를 읽는다', paste.preview, JSON.stringify(paste));

  const applied = await ev(`const A=window.__app; A.confirmPaste();
    const c=A.store.cells; const n=Object.keys(c).length;
    const hong=c['홍길동']||{}; const days=Object.keys(hong).length;
    return {nurses:n, days, first:hong[Object.keys(hong).sort()[0]]};`);
  ok('붙여넣은 근무가 저장된다', applied.nurses >= 2 && applied.days === 4, JSON.stringify(applied));

  step('6 이어짐');
  // ── 6. 이어짐 (병상 단위) ───────────────────────────────────────────────
  // 코어는 토큰 교집합으로 겹침을 센다. 나눠 본 다음 날 같은 병상을 이어받아야 한다.
  const cont = await ev(`const A=window.__app; const s=A.store;
    s.rooms=[['1001',5],['1002',5],['1003',5],['1004',5],['1005',5]];
    s.cells={}; const days=['2026-09-01','2026-09-02'];
    const who=['ㄱ','ㄴ','ㄷ','ㄹ'];
    who.forEach(n=>{ s.cells[n]={}; days.forEach(d=>{ s.cells[n][d]='D'; }); });
    s.cells['ㄱ']['2026-09-01']='DC'; s.cells['ㄱ']['2026-09-02']='DC';
    s.order=who; A.store=s; A.recompute();
    const d1=A.dayInfo('2026-09-01'), d2=A.dayInfo('2026-09-02');
    const cnt=Object.keys(d1.D.labels).length;
    const rooms=(iso,day)=>Object.fromEntries(Object.entries(day.D.labels)
      .map(([l,nm])=>[nm, A.roomsFor('D',cnt,l,iso)]));
    return {d1:rooms('2026-09-01',d1), d2:rooms('2026-09-02',d2)};`);
  const same = Object.keys(cont.d1).every(n => cont.d1[n] === cont.d2[n]);
  ok('같은 인원·같은 근무면 다음 날 방이 그대로', same, JSON.stringify(cont));

  step('7 겹침');
  // ── 7. 겹침 검사 ────────────────────────────────────────────────────────
  // 두 사람이 같은 병상을 보면 잡아야 한다 — 병상 단위로 안 세면 통째로 놓친다.
  const dup = await ev(`const A=window.__app;
    const day=A.dayInfo('2026-09-01');
    const d=A.dupRooms('2026-09-01','D',day);
    return {size:(d&&d.size)||0};`);
  ok('정상 배정에는 겹침이 없다', dup.size === 0, JSON.stringify(dup));

  step('8 마이그레이션');
  // ── 8. 마이그레이션 ─────────────────────────────────────────────────────
  // 옛 데이터 파일을 열었을 때 병실이 프리셋에서 누락되면 그 방을 아무도 안 본다.
  const mig = await ev(`const A=window.__app; const s=A.store;
    s.rooms=[['1001',5],['1002',5],['1003',5],['1004',5],['1005',5],['1006',5],
             ['1007',5],['1008',5],['1009',5],['1010',5],['1011',5],['1012',5],
             ['1013',5],['1014',5]];
    delete s.presets; s.schemes=null; A.store=s; A.migrateStore();
    const miss=[2,3,4,5].map(c=>{ const ps=A.presetsOf(c)||[];
      return ps.length?A.presetAudit(ps[0]).missing.length:-1; });
    return {miss, presets:!!A.store.presets};`);
  ok('구형 파일을 열어도 인원수별 프리셋이 병실을 다 덮는다',
    mig.presets && mig.miss.every(m => m === 0), JSON.stringify(mig));

  // ── 페이지 오류 0 ───────────────────────────────────────────────────────
  const errs = await ev('return (window.__pageErrors||[]).length');
  ok('페이지 오류 없음', !errs, String(errs));
}

let code = 0;
try {
  await main();
} catch (e) {
  fails.push('하네스: ' + e.message);
}
chrome.kill();
try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 지워지면 그만 */ }

if (fails.length) {
  console.log(`assign 로직: ${pass}건 통과, ${fails.length}건 실패`);
  for (const f of fails) console.log('  FAIL  ' + f);
  code = 1;
} else {
  console.log(`assign 로직: ${pass}건 모두 통과`);
}
process.exit(code);
