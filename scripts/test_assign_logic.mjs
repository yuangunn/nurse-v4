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
if (typeof WebSocket === 'undefined') {   // 전역 WebSocket 은 Node 22+
  console.log(`SKIP  이 Node 에는 전역 WebSocket 이 없습니다 (${process.version}, 22 이상 필요)`);
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
  // 돌려준 약속을 window 에 붙잡아 둔다 — 약속이 풀린 직후 그 결과를 넘기기 전에 페이지가 무거운 일(양식 xlsx 풀기)로
  // 가비지 수집을 돌리면, 아무도 안 잡고 있는 약속이 먼저 치워져 CDP 가 "Promise was collected" 를 돌려준다(가끔).
  const call = send('Runtime.evaluate', {
    expression: `window.__evKeep=(()=>{${expr}})()`, returnByValue: true, awaitPromise: true,
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

  // ── 8-b. 서식 102 (방 칸 없는 병동) ─────────────────────────────────────
  // 102 는 자리마다 보는 방이 고정이라 머리글에 한 번 적고, 매일 칸에는 이름만 쓴다.
  // "배정표에 어싸인이 나오지 않게" 라는 요구가 양식에 이미 들어 있다.
  step('8b 서식 102');
  const l102 = await ev(`const A=window.__app;
    return (async()=>{ const t=await A.loadBaseTemplate('102');
      const L=A.findLayout102(A.sheetCells(t), A.sheetMerges(t));
      return {days:(L.wdCols||[]).length, secs:(L.sections||[]).map(x=>x.P+':'+x.rows),
              labels:L.labels, mid:!!L.midRow, evt:!!L.eventRow,
              evtRow:L.eventRow, labelCol:L.labelCol};
    })()`);
  eq('102 구역 — D 4자리 · E 4자리 · N 3자리', l102.secs, ['D:4', 'E:4', 'N:3']);
  eq('102 요일 7칸', l102.days, 7);
  eq('102 자리 이름', l102.labels.slice(0, 4), ['A', 'B', 'C', 'D']);
  ok('102 중간번·교육행사 줄을 찾는다 (교육행사가 표 위에 있어도)',
    l102.mid && l102.evt, JSON.stringify(l102));
  eq('교육·행사는 표 위(4행)', l102.evtRow, 4);
  eq('자리 이름 열은 C', l102.labelCol, 3);

  const f102 = await ev(`const A=window.__app; A.setFormId('102'); A.setWard('102');
    const s=A.store; const iso='2026-09-07';
    s.order=['김차지','이에이','박비','최씨','정야간','한야간','오야간'];
    s.cells={김차지:{[iso]:'DC'},이에이:{[iso]:'D'},박비:{[iso]:'D'},최씨:{[iso]:'D'},
             정야간:{[iso]:'NC'},한야간:{[iso]:'N'},오야간:{[iso]:'N'}};
    A.store=s; A.recompute();
    return (async()=>{ const r=await A.buildWeekXlsx(new Date(2026,8,6));
      const c=A.sheetCells({...r.tpl, sheetXml:r.xml}); const g=k=>c[k]||'';
      // 병동 양식은 요일 칸이 두 칸씩 병합 — 월요일은 F열
      return {D:[g('F5'),g('F6'),g('F7'),g('F8')], N:[g('F14'),g('F15'),g('F16')],
              날짜:g('F3'), 방칸:g('B5')};})()`);
  // 102 는 차지 방이 고정이 아니다 — 자리를 옮기지 말고 최선임 이름 뒤에 /CRN 만 붙인다.
  eq('102 D — 차지는 자리를 옮기지 않고 이름에 /CRN', f102.D, ['김차지 /CRN', '이에이', '박비', '최씨']);
  eq('102 N — 차지는 자리를 옮기지 않고 이름에 /CRN', f102.N, ['정야간 /CRN', '한야간', '오야간']);
  ok('102 날짜는 엑셀 날짜로', /^\d{5}$/.test(String(f102.날짜)), String(f102.날짜));
  // 화면에서 고친 자리와 인쇄된 자리가 달라지면 안 된다.
  const scr102 = await ev(`const A=window.__app; A.setFormId('102'); A.wkSunday=new Date(2026,8,6);
    A.show('week');
    return [...document.querySelectorAll('#wkTable tr')].map(tr=>
      [...tr.children].map(td=>(td.textContent||'').trim()).filter(Boolean)).flat()
      .filter(v=>/김차지|이에이|박비|최씨/.test(v));`);
  eq('102 화면이 인쇄와 같다 (줄 순서 · /CRN 표시)', scr102.slice(0, 4), f102.D);
  eq('102 배정표에 방 번호가 나오지 않는다', f102.방칸, '');
  await ev(`window.__app.setFormId('101'); return 1`);

  // 병합 태그 모양 — 도구마다 다르다. 놓치면 양식 구조가 통째로 어긋난다.
  eq('병합을 공백 있는 자동닫힘 태그에서도 읽는다',
    await ev(`const A=window.__app;
      return A.sheetMerges({sheetXml:'<mergeCells count="3">'
        +'<mergeCell ref="A1:B1"/><mergeCell ref="A4:A7" />'
        +'<mergeCell ref="C1:C2"></mergeCell></mergeCells>'});`),
    ['A1:B1', 'A4:A7', 'C1:C2']);

  // ── 9. 처음 설정 마법사 ─────────────────────────────────────────────────
  // 화면을 새로 만들지 않고 기존 관리 패널을 품는다 — 패널 id 가 바뀌면 빈 단계가 된다.
  step('9 마법사');
  const wiz = await ev(`const A=window.__app; const out=[];
    for(let i=0;i<A.WIZ.length;i++){ A.startWizard(i);
      out.push({id:A.WIZ[i].id, body:document.querySelector('#wizBody').innerHTML.length,
                on:(document.querySelector('#wizSteps span.on')||{}).textContent,
                names:[...document.querySelectorAll('#wizSteps span')].map(e=>e.textContent)}); }
    A.closeWizard(); return out;`);
  // 요일별 필요 인원 단계는 없다 — 완성된 근무표를 받으므로 인원을 재지 않는다 (2026-09-27, 결정 2-28)
  // 환영(파일 만들기)이 0단계다 — 처음 켠 사람이 환영 카드 → 시작 화면 → 마법사로 세 번 갈아타지 않게 (2026-09-27)
  eq('마법사 단계 순서', wiz.map(w => w.id),
    ['hello', 'ward', 'scheme', 'paste', 'codes', 'caps', 'done']);
  ok('단계마다 본문이 그려진다 (패널 id 가 어긋나면 빈다)',
    wiz.filter(w => w.id !== 'hello').every(w => w.body > 200), JSON.stringify(wiz.map(w => [w.id, w.body])));
  eq('진행 막대는 단계 이름', wiz[0].names, ['시작', '병동', '방 구성', '근무표', '표기', '간호사', '끝']);
  eq('지금 단계가 진하다', wiz[3].on, '근무표');

  // 붙여넣기 단계만 전체 화면을 빌려 쓰고, 확정하면 마법사로 돌아온다
  const trip = await ev(`const A=window.__app; A.startWizard(A.WIZ.findIndex(w=>w.id==='paste')); A.wizPaste();
    const away=!document.querySelector('#wiz').classList.contains('on')
      && document.querySelector('#scrPaste').style.display!=='none';
    A.ingestGrid([['이름','9/1','9/2'],['홍길동','D','E'],['김영숙','E','N']]);
    A.confirmPaste();
    const back=document.querySelector('#wiz').classList.contains('on');
    const at=(document.querySelector('#wizSteps span.on')||{}).textContent;
    A.closeWizard();
    return {away, back, at};`);
  ok('붙여넣기는 전체 화면으로 넘어간다', trip.away, JSON.stringify(trip));
  ok('확정하면 마법사 다음 단계로 돌아온다', trip.back && trip.at === '표기', JSON.stringify(trip));

  // 파일이 없으면 환영 단계에서 못 넘어간다 — 다음 단계 패널이 쓸 데이터 파일이 아직 없다
  const hello = await ev(`const A=window.__app; window.__memoryMode=false;
    A.startWizard(3); const at=A.wizAt; A.wizGo(1); const after=A.wizAt;
    const body=document.querySelector('#wizBody').textContent, foot=document.querySelector('#wizFoot').textContent;
    const pri=document.querySelectorAll('#wiz .pri').length;
    window.__memoryMode=true; A.closeWizard();
    return {at, after, 처음시작:/처음 시작/.test(body), 열기:/이미 만든 파일 열기/.test(body), 다음:/다음/.test(foot), pri};`);
  eq('파일이 없으면 환영 단계부터 · 다음 없음 · 주 단추 하나', hello,
    { at: 0, after: 0, 처음시작: true, 열기: true, 다음: false, pri: 1 });

  // ── 10. 화면 상태는 데이터 파일에 ──────────────────────────────────────
  // 병원 PC 는 브라우저를 닫을 때 사이트 데이터를 지우는 경우가 많다.
  // localStorage 에 두면 '인쇄함' 체크가 매일 풀려 시작 안내 카드가 영영 남는다.
  step('10 화면 상태');
  const ui = await ev(`const A=window.__app;
    // 옛 파일 흉내 — localStorage 에만 있던 상태
    localStorage.setItem('assignPrinted','1');
    localStorage.setItem('assignOnboardHidden','1');
    const s=A.store; delete s.ui; A.store=s; A.migrateStore();
    return {옮김:A.store.ui, 옛값남음:[localStorage.getItem('assignPrinted'),
              localStorage.getItem('assignOnboardHidden')]};`);
  eq('옛 localStorage 상태를 데이터 파일로 옮긴다', ui.옮김, { printed: 1, obHidden: 1 });
  eq('옮긴 뒤 옛 값은 지운다', ui.옛값남음, [null, null]);

  const uiKeep = await ev(`const A=window.__app;
    const s=A.store; s.ui={}; A.store=s;
    A.hideOnboard();
    const a=!!A.store.ui.obHidden;
    A.showOnboard();
    return {숨김저장:a, 되돌림:!A.store.ui.obHidden};`);
  ok('숨기기·되돌리기가 데이터 파일에 남는다', uiKeep.숨김저장 && uiKeep.되돌림, JSON.stringify(uiKeep));

  // ── 11. 필요 인원은 재지 않는다 ────────────────────────────────────────
  // 이 도구는 완성된 근무표를 받는다 — 인원이 맞는지는 근무표를 짤 때 정해졌다 (2026-09-27, 결정 2-28).
  // 예전엔 요일별 필요 인원을 두고 확인 카드·고치기 화면에서 '인원이 다릅니다'를 띄웠다.
  step('11 필요 인원 없음');
  const noReq = await ev(`const A=window.__app; const s=A.store;
    s.req={mon:{D:9,E:9,N:9}};                         // 옛 파일 흉내
    s.order=['가','나','다','라','마','바'];
    s.cells={}; s.unit={}; s.order.forEach(n=>s.cells[n]={});
    // 2026-09-06(일) ~ 09-12(토) — 매일 D 2 · E 2 · N 1 (옛 기본값과 모두 다르다)
    const days=['2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12'];
    days.forEach(iso=>s.order.forEach((n,k)=>{ s.cells[n][iso]=['D','D','E','E','N','OF'][k]; }));
    A.store=s; A.migrateStore(); A.recompute(); A.wkSunday=new Date(2026,8,6); A.show('week');
    const warn=(document.querySelector('#wkWarn')||{}).textContent||'';
    A.show('admin'); const menu=(document.querySelector('#adminNav')||{}).textContent||'';
    A.show('edit');
    const foot=[...document.querySelectorAll('#wrap tfoot td')].map(e=>e.textContent).filter(Boolean);
    const out={옛값:'req' in A.store, 카드:/필요 인원|인원이/.test(warn),
      관리:!!A.ADMIN_PANELS.req||/필요 인원/.test(menu), 칩:!!document.querySelector('#edMis'),
      숫자만:foot.length>0&&foot.every(t=>/^[0-9]+$/.test(t))};
    A.show('week'); return out;`);
  eq('필요 인원을 어디서도 재지 않는다', noReq, { 옛값: false, 카드: false, 관리: false, 칩: false, 숫자만: true });

  // 방 구성 주간 계획표는 인원수 탭을 따른다 — 필요 인원이 없으니 '그 근무가 n명인 날'의 표
  const plan = await ev(`const A=window.__app; const s=A.store;
    s.presets={5:[],4:[{id:'pz',name:'회진일',rooms:JSON.parse(JSON.stringify(s.schemes[4]||{}))}],3:[],2:[]};
    s.presetPlan={}; s.presetDay={}; A.store=s;
    A.show('admin'); A.pickAdmin('schemes');
    A.presetUI.cnt=5; A.renderSchemes();
    const five=(document.querySelector('#planBox')||{}).textContent||'';
    const fiveSel=document.querySelectorAll('#planTable select').length;
    A.presetUI.cnt=4; A.renderSchemes();
    const sel=document.querySelector('#planTable select');
    const title=sel?sel.title:'';
    // 화요일 D 칸 = 표의 D 줄 세 번째 칸 (일·월·화)
    const tueD=document.querySelectorAll('#planTable tr')[1].querySelectorAll('select')[2];
    tueD.value='pz'; tueD.dispatchEvent(new Event('change',{bubbles:true}));
    const saved=((A.store.presetPlan.tue||{}).D||{})[4];
    const used=(A.presetFor('D',4,'2026-09-08')||{}).id, other=(A.presetFor('D',5,'2026-09-08')||{}).id;
    A.presetUI.cnt=5; A.show('week');
    return {기본뿐:/기본.*하나뿐/.test(five)&&fiveSel===0, 제목:/4명일 때/.test(title), 저장:saved, 화D4:used, 화D5:other};`);
  eq('주간 계획표가 인원수 탭을 따른다', plan, { 기본뿐: true, 제목: true, 저장: 'pz', 화D4: 'pz', 화D5: 'default' });

  // ── 12. 규칙과 다른 병동 병실 ─────────────────────────────────────────
  // 122 는 실제로 51~63 + 70 (64 없음). 규칙만 쓰면 병동이 손으로 고쳐야 했다.
  step('12 병실 예외');
  eq('122 병실은 51~63 + 70',
    await ev(`const A=window.__app; const r=A.wardRooms('122');
      return [r.length, r[0], r[12], r[13]];`),
    [14, '1251', '1263', '1270']);
  eq('규칙 밖 호실도 자리를 갖는다 (없으면 병동 전환이 끊긴다)',
    await ev(`const A=window.__app; return [A.roomPos('1270'), A.roomPos('1251'), A.roomPos('964')];`),
    [14, 1, 14]);
  eq('예외가 없는 병동은 규칙대로',
    await ev(`const A=window.__app; const r=A.wardRooms('92'); return [r[0], r[13]];`),
    ['951', '964']);

  // ── 13. 서식이 배정표 화면을 바꾼다 ───────────────────────────────────
  // 화면과 양식이 어긋나면 사람이 화면에는 보이는데 인쇄물에서 사라진다.
  step('13 서식별 화면');
  const perForm = await ev(`const A=window.__app; const out={};
    for(const id of ['101','122','102']){ A.setFormId(id);
      out[id]={rows:['D','E','N'].map(P=>A.secRows(P)), noRooms:A.formNoRooms()}; }
    A.setFormId('101'); return out;`);
  eq('101 자리 수 5·5·3 · 방 칸 있음', [perForm['101'].rows, perForm['101'].noRooms], [[5, 5, 3], false]);
  // 122 는 D 가 6줄 — 대체간호사가 오는 날 여섯이 병실을 나눈다 (2026-09-27 병동 양식)
  eq('122 자리 수 6·5·3 · 방 칸 있음', [perForm['122'].rows, perForm['122'].noRooms], [[6, 5, 3], false]);
  eq('102 자리 수 4·4·3 · 방 칸 없음', [perForm['102'].rows, perForm['102'].noRooms], [[4, 4, 3], true]);


  const wkCols = await ev(`const A=window.__app; const s=A.store; const iso='2026-09-07';
    s.order=['가','나','다','라','마','바']; s.cells={};
    s.order.forEach((n,i)=>{ s.cells[n]={[iso]: i===0?'DC' : i<5?'D':'N'}; });
    A.store=s; A.recompute(); A.wkSunday=new Date(2026,8,6);
    const look=id=>{ A.setFormId(id); A.show('week');
      const rm=document.querySelectorAll('#wkTable td.rm').length;
      const sub=[...document.querySelectorAll('#wkTable .midlab')].map(e=>e.textContent.trim());
      return {rm, sub}; };
    const a=look('101'), b=look('102'); A.setFormId('101'); A.show('week');
    return {101:a, 102:b};`);
  ok('101 은 방 칸이 나온다', wkCols['101'].rm > 0, JSON.stringify(wkCols['101']));
  eq('102 는 방 칸이 나오지 않는다', wkCols['102'].rm, 0);
  ok('대체 줄은 양식에 있을 때만 (지금 102 양식엔 없다)',
    !wkCols['102'].sub.includes('대체'), JSON.stringify(wkCols['102'].sub));

  // ── 14. 쉬는 사람을 근무로 올리기 ─────────────────────────────────────
  // 배정표에는 근무인 사람만 나오므로, OF 로 바꾼 사람은 화면에서 사라져
  // 되돌리기나 '근무표 고치기' 로 가야만 되돌릴 수 있었다.
  step('14 휴무자 추가');
  const cands = await ev(`const A=window.__app; const s=A.store; const iso='2026-09-07';
    s.order=['근무자','쉬는사람','연차자','야간전날','자격없음'];
    s.cells={근무자:{[iso]:'D'},쉬는사람:{[iso]:'OF'},연차자:{[iso]:'V'},
             야간전날:{'2026-09-06':'N',[iso]:'OF'},자격없음:{[iso]:'OF'}};
    s.caps={근무자:['D'],쉬는사람:['DC','D'],연차자:['D'],야간전날:['D'],자격없음:['N']};
    A.store=s; A.recompute();
    return A.offCandidates(iso,'D').map(c=>[c.n,c.code,c.can,c.bad]);`);
  ok('근무 중인 사람은 목록에 없다', !cands.some(c => c[0] === '근무자'), JSON.stringify(cands));
  ok('쉬는 사람·연차자는 나온다',
    cands.some(c => c[0] === '쉬는사람') && cands.some(c => c[0] === '연차자'), JSON.stringify(cands));
  ok('가능 근무가 아니면 표시된다',
    cands.find(c => c[0] === '자격없음')[2] === false, JSON.stringify(cands));
  ok('전날 야간이면 금지 전환으로 표시된다',
    cands.find(c => c[0] === '야간전날')[3] === true, JSON.stringify(cands));
  eq('고르기 쉬운 순서 — 가능 근무가 먼저', cands[0][2], true);

  // ── 15. 근무표를 넣으면 어느 주로 가나 ────────────────────────────────
  // 이번 달 근무표를 달 중간에 넣었는데 첫 주가 뜨면 매번 [오늘]을 눌러야 한다.
  step('15 넣은 뒤 이동할 주');
  const jump = await ev(`const A=window.__app;
    const iso=d=>d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
    const sun=d=>{const x=new Date(d); x.setHours(0,0,0,0); x.setDate(x.getDate()-x.getDay()); return iso(x);};
    // 한 달만 넣으면 오늘이 그 달 첫 주일 때 검사가 헛돈다 — 지난달부터 두 달을 넣어
    // 넣은 기간의 첫 주가 오늘 주와 반드시 다르게 만든다.
    const grid=(from,to)=>{ const head=['이름'], n=[];
      for(let d=new Date(from); d<=to; d.setDate(d.getDate()+1)){
        head.push((d.getMonth()+1)+'/'+d.getDate()); n.push('D'); }
      return [head, ['가간호', ...n], ['나간호', ...n.map(()=>'E')]]; };
    const put=(from,to)=>{ A.store={...A.store, cells:{}, order:[]};
      A.ingestGrid(grid(from,to)); A.confirmPaste(); return iso(A.wkSunday); };
    const t=new Date(); t.setHours(0,0,0,0);
    const 지난달1일=new Date(t.getFullYear(), t.getMonth()-1, 1);
    const 이번달말=new Date(t.getFullYear(), t.getMonth()+1, 0);
    const 안에=put(지난달1일, 이번달말);
    const 앞=new Date(t.getFullYear(), t.getMonth()+3, 1);
    const 뒤=new Date(t.getFullYear(), t.getMonth()+4, 0);
    const 밖에=put(앞, 뒤);
    return {안에, 오늘주:sun(t), 밖에, 그기간첫주:sun(앞), 첫주:sun(지난달1일)};`);
  ok('검사가 헛돌지 않는다 (넣은 기간 첫 주 ≠ 오늘 주)', jump.첫주 !== jump.오늘주,
    JSON.stringify(jump));
  eq('오늘이 넣은 기간 안이면 오늘 주로 간다', jump.안에, jump.오늘주);
  eq('기간 밖이면 넣은 기간의 첫 주로 간다', jump.밖에, jump.그기간첫주);

  // ── 16. 한 장에 표가 둘인 번표 · 82병동 SU ────────────────────────────
  // 82병동 파트장은 병동과 SU(Stroke unit) 근무표를 한 시트에서 관리한다. 통째로
  // 붙이면 SU 간호사가 병동 명부에 섞여 병동 자리에 배정됐다 (2026-09-21 제보).
  step('16 두 표 가르기 · SU');
  const two = await ev(`const A=window.__app; A.setFormId('82'); A.setWard('82');
    const s=A.store; s.cells={}; s.order=[]; s.unit={}; A.store=s;
    A.ingestGrid([
      ['이름','8/30','8/31','9/1','9/2','9/3','9/4','9/5'],
      ['가병동','D','D','D','D','D','D','D'],
      ['나병동','D','D','D','D','D','D','D'],
      ['다병동','E','E','E','E','E','E','E'],
      ['라병동','E','E','E','E','E','E','E'],
      ['마병동','N','N','N','N','N','N','N'],
      ['바병동','중','중','중','중','중','중','중'],
      ['계','6','6','6','6','6','6','6'],
      ['근무','O','O','O','O','O','O','O'],
      ['2026년 9월(SU)','','','','','','',''],
      ['이름','30','31','1','2','3','4','5'],
      ['가에스유','D','D','D','D','D','D','D'],
      ['나에스유','E','E','E','E','E','E','E'],
      ['다에스유','N','N','N','N','N','N','N'],
    ]);
    A.confirmPaste();
    return {명부:A.store.order, 소속:A.store.unit};`);
  eq('합계·범례 줄은 사람이 아니다', two.명부.filter(n => ['계','근무','중간번','일자','요일'].includes(n)), []);
  eq('두 번째 표는 SU 소속으로 가른다', Object.keys(two.소속).sort(), ['가에스유','나에스유','다에스유']);
  eq('병동은 병동만', two.명부.filter(n => !two.소속[n]),
    ['가병동','나병동','다병동','라병동','마병동','바병동']);

  const su = await ev(`const A=window.__app;
    return {D:A.unitWorker('2026-09-01','D','SU'), E:A.unitWorker('2026-09-01','E','SU'),
            N:A.unitWorker('2026-09-01','N','SU'),
            자리:['D','E','N'].map(P=>A.slotsOf(P).join(','))};`);
  eq('82 자리 구성', su.자리, ['차지,A,SU,중간번', '차지,A,SU', '차지,SU']);
  eq('SU 칸에는 SU 소속이 들어간다', [su.D, su.E, su.N], ['가에스유','나에스유','다에스유']);

  const x82 = await ev(`const A=window.__app;
    return (async()=>{ const r=await A.buildWeekXlsx(new Date(2026,7,30));
      const c=A.sheetCells({...r.tpl, sheetXml:r.xml}); const g=k=>c[k]||'';
      // 주는 8/30(일)부터 — F열이 9/1
      return {날짜:g('F3'), D:[g('F4'),g('F5'),g('F6'),g('F7')],
              E:[g('F8'),g('F9'),g('F10')], N:[g('F11'),g('F12')]};})()`);
  eq('82 날짜는 글자로 (엑셀 날짜를 넣으면 5자리 수가 찍힌다)', x82.날짜, '9월 1일');
  eq('82 D — 병동 2명 · SU · 중간번', x82.D, ['가병동','나병동','가에스유','바병동']);
  eq('82 E — 병동 2명 · SU', x82.E, ['다병동','라병동','나에스유']);
  eq('82 N — 병동 1명 · SU', x82.N, ['마병동','다에스유']);

  // 전달 말일부터 시작하는 번표 — 첫 칸을 이번 달에 걸면 표 전체가 한 달 밀린다
  const anchor = await ev(`const A=window.__app;
    const days=Object.keys(A.store.cells['가병동']||{}).sort();
    return {첫날:days[0], 끝날:days[days.length-1]};`);
  eq('30·31 로 시작하면 전달로 건다', anchor.첫날, '2026-08-30');
  eq('그 다음은 이번 달', anchor.끝날, '2026-09-05');

  // ── 17. 병동과 서식은 한 쌍 ───────────────────────────────────────────
  step('17 병동↔서식 연동');
  const link = await ev(`const A=window.__app; const out={};
    const now=()=>[A.store.ward, A.formId(), A.store.rooms.length?A.store.rooms[0][0]:''];
    A.setWard('101'); out.병동101=now();
    A.setWard('82');  out.병동82=now();
    A.setFormId('122'); out.서식122=now();
    A.setWard('61');  out.양식없는병동=now();
    out.있나={'82':A.formFor('82'),'61':A.formFor('61')};
    return out;`);
  eq('병동을 고르면 서식도 따라온다', link.병동82, ['82', '82', '851']);
  eq('서식을 고르면 병동·방도 따라온다', link.서식122, ['122', '122', '1251']);
  eq('양식 없는 병동은 쓰던 서식을 그대로 둔다', link.양식없는병동, ['61', '122', '601']);
  eq('이 병동 양식이 있나', link.있나, { '82': '82', '61': '' });

  // ── 18. 올린 양식의 모양을 구조로 읽는다 ──────────────────────────────
  // 병동마다 양식이 다르므로 가정하지 않는다 — 내장 4벌로 검출기를 되짚어 본다.
  step('18 양식 모양 판별');
  const shapes = await ev(`const A=window.__app;
    return (async()=>{ const out={};
      for(const id of ['101','122','102','82']){
        const tpl=await A.loadBaseTemplate(id);
        const sh=A.detectFormShape(A.sheetCells(tpl),A.sheetMerges(tpl));
        out[id]=sh?[sh.kind,sh.noRooms,!!sh.dateText,sh.unitSlot||'']:'못 읽음';
      }
      return out;})()`);
  eq('101 — 방 칸 있음', shapes['101'], ['101', false, false, '']);
  eq('122 — 방을 따로 세 열에', shapes['122'], ['122', false, false, '']);
  eq('102 — 방 칸 없음', shapes['102'], ['102', true, false, '']);
  eq('82 — 방 칸 없음 · 날짜 글자 · SU 칸', shapes['82'], ['82', true, true, 'SU']);

  const slots82 = await ev(`const A=window.__app;
    return (async()=>{ const tpl=await A.loadBaseTemplate('82');
      const sh=A.detectFormShape(A.sheetCells(tpl),A.sheetMerges(tpl));
      return ['D','E','N'].map(P=>sh.slots[P].join(','));})()`);
  eq('82 자리를 손으로 쓴 서식과 같게 읽는다', slots82,
    ['차지,A,SU,중간번', '차지,A,SU', '차지,SU']);

  // ── 19. 82 화면과 인쇄가 같은가 ───────────────────────────────────────
  // 82 병동 원본에는 /CRN 표시가 없다 — 화면에만 붙으면 어긋난다.
  step('19 82 화면=인쇄');
  const crn = await ev(`const A=window.__app; const out={};
    for(const id of ['102','82']){ A.setFormId(id); out[id]=!!A.formDef().crnMark; }
    A.setFormId('101'); return out;`);
  eq('102 는 이름 뒤에 /CRN, 82 는 안 찍는다', crn, { '102': true, '82': false });

  // ── 20. 엑셀 클립보드 글자 ────────────────────────────────────────────
  // 엑셀은 칸 안에 줄바꿈이 있으면 그 칸을 큰따옴표로 감싸 내보낸다. \n 으로 순진하게
  // 자르면 표 전체가 찢어진다 — 82병동 번표가 42행 → 74줄이 되어 명부에 메모 조각만 남았다.
  step('20 클립보드 해석');
  const clip = await ev(`const A=window.__app;
    const q=String.fromCharCode(34), nl=String.fromCharCode(10), tab=String.fromCharCode(9), cr=String.fromCharCode(13);
    const txt=['이름',q+'잔'+nl+'여'+nl+'휴'+nl+'가'+q,'9/1','9/2'].join(tab)+cr+nl+
              ['가간호','3','D','E'].join(tab)+cr+nl+
              ['나간호',q+'메모에 '+q+q+'따옴표'+q+q+' 와'+nl+'줄바꿈'+q,'N','OF'].join(tab)+cr+nl;
    const g=A.parseClipboard(txt);
    return {줄:g.length, 칸:g.map(r=>r.length), 머리:g[0][1], 메모:g[2][1], 끝줄:g[g.length-1].join('')};`);
  eq('줄바꿈이 든 칸이 줄을 찢지 않는다', clip.칸.slice(0, 3), [4, 4, 4]);
  eq('칸 안의 줄바꿈은 빈칸으로', clip.머리, '잔 여 휴 가');
  eq('두 번 쓴 따옴표는 하나로', clip.메모, '메모에 "따옴표" 와 줄바꿈');

  // ── 21. 다른 소속(SU)이 화면에 보이는가 ───────────────────────────────
  // "뒤에서 코드로는 정리돼 있지만 유저는 모른다" (2026-09-21 사용자 지적).
  step('21 SU 가 눈에 보인다');
  const vis = await ev(`const A=window.__app; A.setFormId('82'); A.setWard('82');
    const s=A.store; s.cells={}; s.unit={};
    s.order=['가에스유','가병동','나에스유','나병동','다병동'];
    for(const n of s.order){ s.cells[n]={}; for(let d=1;d<=30;d++)
      s.cells[n]['2026-09-'+String(d).padStart(2,'0')]=/에스유/.test(n)?'D':(n==='가병동'?'D':n==='나병동'?'D':'E'); }
    s.unit={가에스유:'SU',나에스유:'SU'};
    A.store=s; A.groupUnits(); A.recompute();
    const order=A.store.order.slice();
    A.show('edit');
    // 앞선 검사가 달을 옮겨 놓았을 수 있다 — 단추로 2026년 9월까지 간다
    for(let i=0;i<24&&!/2026년 9월$/.test(document.querySelector('#edTitle').textContent);i++){
      const t=document.querySelector('#edTitle').textContent.match(/([0-9]+)년 ([0-9]+)월/);   // 템플릿 리터럴 안에서는 \\d 가 d 가 된다
      const cur=+t[1]*12+ +t[2], want=2026*12+9;
      [...document.querySelectorAll('button')].find(b=>(b.getAttribute('onclick')||'')===
        (cur<want?'moveEditMonth(1)':'moveEditMonth(-1)')).click(); }
    const heads=[...document.querySelectorAll('#wrap tr.unitHd')].map(e=>(e.textContent||'').trim().slice(0,4));
    const foot=[...document.querySelectorAll('#wrap tfoot th')].map(e=>(e.textContent||'').trim());
    const d1=id=>(document.getElementById(id)||{}).textContent||'';
    return {order, heads, foot, 달:(document.querySelector('#edTitle')||{}).textContent,
      병동D:d1('cnt-D-0'), SU_D:d1('cnt-SU-D-0'),
      후보:A.offCandidates('2026-09-07','N').map(c=>c.n)};`);
  eq('SU 는 명부 뒤쪽에 모인다 (소속 안 순서는 그대로)', vis.order,
    ['가병동','나병동','다병동','가에스유','나에스유']);
  eq('근무표 고치기에 구역 머리줄이 있다', vis.heads, ['병동 —', 'SU —']);
  ok('인원을 병동과 SU 로 따로 센다',
    vis.foot.includes('병동 D 인원') && vis.foot.includes('SU D'), JSON.stringify(vis.foot));
  // SU 2명 + 병동 2명이 D — 같이 세면 4 가 된다
  ok('병동 D 인원에 SU 가 섞이지 않는다', /^2/.test(vis.병동D), vis.병동D+' @'+vis.달);
  eq('SU D 도 숫자만 (칸 수와 견주지 않는다 — 넘치면 배정표 확인 카드가 알린다)', vis.SU_D, '2');
  ok('쉬는 사람 후보에 SU 가 없다', !vis.후보.some(n => /에스유/.test(n)), JSON.stringify(vis.후보));

  const pick = await ev(`const A=window.__app; A.wkSunday=new Date(2026,8,6); A.show('week');
    const td=[...document.querySelectorAll('#wkTable td.nm')][0]; if(!td) return '이름 칸 없음';
    td.click();
    const t=(document.querySelector('#pick')||{}).textContent||'';
    const warn=(document.querySelector('#wkWarn')||{}).textContent||'';
    if(A.closePick) A.closePick();
    return {넣기:/쉬는 간호사 넣기/.test(t)&&/대체간호사 넣기/.test(t), 방번호:/[0-9]{2}~[0-9]{2}|[0-9]{2}, [0-9]{2}/.test(t.split('이 근무에')[0]),
      방경고:/아무도 안 보는 방|겹치는 방/.test(warn)};`);
  eq('어싸인 바꾸기 모달에 [쉬는 간호사 넣기]·[대체간호사 넣기]가 있다', pick.넣기, true);
  eq('방 칸 없는 서식은 모달에 방 번호를 안 보인다', pick.방번호, false);
  eq('방 칸 없는 서식은 방 경고를 안 띄운다', pick.방경고, false);

  // 제목에 (SU) 가 없어도 두 번째 표는 다른 소속 — 조용히 섞이면 처음 버그로 돌아간다
  const untitled = await ev(`const A=window.__app; const s=A.store; s.cells={}; s.order=[]; s.unit={}; A.store=s;
    A.ingestGrid([['이름','9/1','9/2','9/3','9/4'],['가병동','D','D','D','D'],['나병동','E','E','E','E'],
      ['이름','1','2','3','4'],['가에스유','D','D','D','D']]);
    A.confirmPaste(); return A.store.unit;`);
  eq('제목 없는 두 번째 표도 서식의 소속 이름으로 가른다', untitled, { '가에스유': 'SU' });

  // 붙여넣기는 필요 인원을 만들거나 맞추지 않는다 (결정 2-28)
  const pasted = await ev(`const A=window.__app; const s=A.store; s.cells={}; s.order=[]; s.unit={}; A.store=s;
    A.ingestGrid([['이름','9/7','9/8','9/9','9/10'],['가병동','D','D','D','D'],['나병동','D','D','D','D'],
                  ['다병동','E','E','E','E'],['라병동','N','N','N','N']]);
    A.confirmPaste(); return {req:'req' in A.store, 사람:A.store.order.length};`);
  eq('붙여넣기가 필요 인원을 만들지 않는다', pasted, { req: false, 사람: 4 });
  await ev(`window.__app.setFormId('101'); return 1`);

  // ── 22. 화면 인쇄가 없는 서식은 101 인쇄 틀로 빠지지 않는다 ──────────
  // 82 가 101 틀로 빠져 방 칸이 있고 SU 줄이 없는 종이가 나오고 있었다 (2026-09-27).
  // 102·82 는 엑셀로 받아 엑셀에서 인쇄한다 — 도구 띠의 검정 단추도 엑셀로 바뀐다.
  step('22 인쇄 서식 가드');
  const guard = await ev(`const A=window.__app; return (async()=>{
    const s=A.store; s.cells={}; s.unit={}; s.order=['가간호','나간호','다간호','라간호'];
    for(const n of s.order){ s.cells[n]={}; for(let d=13;d<=19;d++) s.cells[n]['2026-09-'+d]=['D','D','E','N'][s.order.indexOf(n)]; }
    A.store=s; A.recompute(); A.wkSunday=new Date(2026,8,13);
    const out={can:{}};
    for(const id of ['101','122','102','82']){ A.setFormId(id); out.can[id]=A.canPrint(); }
    const bar=()=>{ A.show('week'); const p=document.querySelector('#btnPrint'), x=document.querySelector('#btnXlsx');
      return {인쇄:getComputedStyle(p).display!=='none', 엑셀주:x.classList.contains('pri')}; };
    A.setFormId('82'); out.bar82=bar();
    let msg=''; try{ await A.buildPrintArea(false); msg='만들어짐'; }catch(e){ msg=e.message; }
    const pa=document.querySelector('#printArea');
    out.print82={엑셀안내:/엑셀/.test(msg), 장:pa.querySelectorAll('.sheet').length, 표:!!pa.querySelector('table')};
    let called=false; const keep=window.print; window.print=()=>{ called=true; };
    await A.printWeek(false); await new Promise(r=>setTimeout(r,300)); window.print=keep;
    out.print82.인쇄창=called;
    A.setFormId('101'); out.bar101=bar();
    return out; })();`);
  eq('화면 인쇄는 101·122 만', guard.can, { '101': true, '122': true, '102': false, '82': false });
  eq('82 는 [인쇄]를 숨기고 엑셀이 주 단추', guard.bar82, { 인쇄: false, 엑셀주: true });
  eq('101 은 [인쇄]가 주 단추', guard.bar101, { 인쇄: true, 엑셀주: false });
  eq('82 인쇄 영역은 101 표가 아니라 안내 한 장', guard.print82, { 엑셀안내: true, 장: 1, 표: false, 인쇄창: false });

  // 저장 상태는 머리줄 알약 하나에 (사용자 시안 2026-09-28, 결정 2-37) — 따로 뜨던 빨간 배지(saveDot)는 없다.
  // 초록 '저장됨 · 시각' · 회색 '저장 중…'(고친 것이 아직 파일에 없을 때도) · ⚠ 는 짧게 · 읽기 전용은 노랑.
  // 쓸 수 없는 상태(파일 없음·읽기 전용)에서는 알약이 이미 말하므로 저장 상태를 덧붙이지 않는다. 경로는 툴팁에.
  const chip = await ev(`const A=window.__app; const el=document.querySelector('#fileInfo'), t=()=>el.textContent.trim(), c=k=>el.classList.contains(k);
    const out={배지:!!document.querySelector('#saveDot')};
    const keepSaved=A.store.saved, keepDirty=A.dirty; const sv=new Date(); sv.setHours(14,2,0,0); A.store.saved=sv.toISOString(); A.dirty=false;
    A.setFileLoc({kind:'file',name:'assign-data.js'}); A.saveMsg('저장됨'); out.저장됨=t()==='저장됨 · 14:02'&&c('ok');
    out.경로툴팁=el.title.startsWith('파일: assign-data.js');
    A.saveMsg('저장 중…'); out.저장중=t()==='저장 중…'&&c('busy');
    A.saveMsg(''); A.dirty=true; A.renderFileInfo(); out.고친것대기=t()==='저장 중…'&&c('busy'); A.dirty=false;
    A.saveMsg('⚠ 저장 보류 (파일 확인 불가)'); out.보류=t()==='저장 보류'&&c('off');
    A.saveMsg(''); A.setFileLoc({kind:'sidecar',name:'assign-data.js'}); out.읽기전용=t()==='읽기 전용'&&c('warn');
    A.setFileLoc({kind:'none'}); A.saveMsg('⚠ 파일 미연결 — 저장되지 않음'); out.미연결중복=/파일 미연결/.test(t());
    A.store.saved=keepSaved; A.dirty=keepDirty; A.saveMsg(''); return out;`);
  eq('저장 상태는 머리줄 알약 하나에', chip, { 배지: false, 저장됨: true, 경로툴팁: true, 저장중: true, 고친것대기: true, 보류: true, 읽기전용: true, 미연결중복: false });

  // 머리줄 — 가운데 탭 셋(배정표·근무표·관리), 보고 있는 화면만 켜짐. 떠 있던 ? 단추는 없고 머리줄 [도움말].
  const hdr = await ev(`const A=window.__app; const on=()=>[...document.querySelectorAll('.tbTabs .tab.on')].map(b=>b.textContent.trim());
    const out={탭:[...document.querySelectorAll('.tbTabs .tab')].map(b=>b.textContent.trim()), 떠있는물음표:!!document.querySelector('#helpFab'),
      도움말:!!document.querySelector('.tbR #helpBtn')};
    A.show('week'); out.배정표=on(); A.show('edit'); out.근무표=on(); A.show('paste'); out.넣기=on(); A.show('admin'); out.관리=on();
    out.aria=document.querySelector('#tabAdmin').getAttribute('aria-current');
    A.show('week'); return out;`);
  eq('머리줄 탭과 도움말', hdr, { 탭: ['배정표', '근무표', '관리'], 떠있는물음표: false, 도움말: true,
    배정표: ['배정표'], 근무표: ['근무표'], 넣기: ['근무표'], 관리: ['관리'], aria: 'page' });

  // 이름 클릭 창 — 근무 코드는 접혀 있다가 펼치면 보이고, 펼친 것은 창을 다시 열어도 남는다
  const fold = await ev(`const A=window.__app; A.show('week');
    const td=document.querySelector('#wkTable td.nm'); if(!td) return '이름 칸 없음';
    const vis=()=>getComputedStyle(document.querySelector('#pick .shl')).display!=='none';
    td.click(); const a=vis(); A.togglePickShifts(); const b=vis(); A.closePick();
    td.click(); const c=vis(); A.togglePickShifts(); A.closePick();
    return {처음:a, 펼침:b, 다시열기:c, 끝:A.pkShiftOpen};`);
  eq('근무 코드는 접혀 있다가 펼치면 보인다', fold, { 처음: false, 펼침: true, 다시열기: true, 끝: false });

  // ── 23. 대체간호사 · 빈 자리 (2026-09-27) ──────────────────────────────
  // 122 는 D 가 6줄 — 5명인 날은 한 칸이 비고, 그 칸을 누르면 쉬는 간호사·대체간호사를 넣는다.
  // 대체간호사는 근무표에 없는 사람이라 store.relief 에만 있고, 한 사람으로 세어 병실을 나눈다.
  step('23 대체간호사 · 빈 자리');
  const rel = await ev(`const A=window.__app; const s=A.store;
    Object.assign(s,{cells:{},order:[],unit:{},relief:{},ovr:{},ovrPair:{},trainee:{},trOv:{},hidden:{},caps:{},roomOv:{},presetDay:{},presetPlan:{}});
    A.store=s; A.setFormId('122');
    const names=['가','나','다','라','마','바','사','아','자','차','카','타','파','하'];
    names.forEach((n,i)=>{ s.order.push(n); s.cells[n]={};
      for(let d=6; d<=12; d++) s.cells[n]['2026-09-'+String(d).padStart(2,'0')]= i<5?'D': i<10?'E': i<13?'N':'OF'; });
    A.recompute(); A.wkSunday=new Date(2026,8,6); A.show('week');
    const empD=[...document.querySelectorAll('#wkTable td.emp[data-empty]:not(.rm)')].filter(t=>t.dataset.p==='D').length;
    const seats={D:A.seatsFor('D'),E:A.seatsFor('E'),N:A.seatsFor('N')}, tabs=A.cntTabs();
    const td=document.querySelector('#wkTable td.emp[data-empty]:not(.rm)[data-p="D"]');
    td.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:400,clientY:400}));
    const pk=(document.querySelector('#pick')||{}).textContent||'';
    A.closePick();
    s.relief={'2026-09-07':{D:['대체한명']}}; A.recompute(); A.renderWeek();
    const lab=(A.result.byNurse['대체한명']||{})['2026-09-07'];
    const day=A.dayInfo('2026-09-07');
    const shown=[...document.querySelectorAll('#wkTable td.nm')].some(t=>t.dataset.n==='대체한명'&&t.textContent.includes('대체'));
    const empAfter=[...document.querySelectorAll('#wkTable td.emp[data-empty]:not(.rm)')].filter(t=>t.dataset.p==='D').length;
    const res={empD, seats, tabs, 두길:pk.includes('쉬는 간호사 넣기')&&pk.includes('대체간호사 넣기'),
      자리:!!(lab&&lab.label), D인원:Object.keys(day.D.labels).length, shown, empAfter,
      차지:day.D.labels['차지']==='대체한명'};
    s.relief={'2026-09-07':{D:['가']}}; res.명부이름=A.reliefDay('2026-09-07');
    s.relief={}; A.recompute(); return res;`);
  eq('122 D 가 5명인 날은 빈 자리 하나 (한 주 7칸)', rel.empD, 7);
  eq('자리 수 — 122 D 6 · 나머지 5', rel.seats, { D: 6, E: 5, N: 5 });
  eq('방 구성에 6인 탭이 생긴다', rel.tabs, [6, 5, 4, 3, 2]);
  ok('빈 자리를 누르면 쉬는 간호사·대체간호사 두 길', rel.두길);
  ok('대체간호사도 한 사람으로 세어 자리를 받는다', rel.자리 && rel.D인원 === 6, JSON.stringify(rel));
  ok('대체간호사 이름 옆에 대체 표시', rel.shown);
  eq('대체간호사가 들어간 날은 빈 자리가 준다', rel.empAfter, 6);
  eq('대체간호사는 차지를 맡지 않는다', rel.차지, false);
  eq('우리 명부 이름은 대체간호사로 세지 않는다', rel.명부이름, []);
  // 101 은 5줄이라 여섯째는 헬퍼 — 서식이 자리 수를 정한다
  eq('101 은 D 도 5자리', await ev(`const A=window.__app; A.setFormId('101'); const n=A.seatsFor('D'); const t=A.cntTabs(); A.setFormId('122'); return [n,t];`),
    [5, [5, 4, 3, 2]]);

  // ── 24. 신규 표시가 끝나는 날 (2026-09-27) ─────────────────────────────
  // 예전엔 근무표 어디에든 /D 가 남아 있으면 영영 '신규'였다 — 몇 달 전 교육 기간 기록 때문에.
  step('24 신규 표시');
  const nw = await ev(`const A=window.__app; const s=A.store;
    const d=k=>{ const x=new Date(); x.setDate(x.getDate()+k); return A.isoOfD(x); };
    s.order=['선배','새내기','옛신규']; s.cells={선배:{},새내기:{},옛신규:{}}; s.newUntil={};
    s.cells.새내기[d(-3)]='/D'; s.cells.새내기[d(2)]='/E'; s.cells.새내기[d(5)]='/D'; s.cells.새내기[d(6)]='D';
    s.cells.옛신규[d(-90)]='/D'; s.cells.옛신규[d(-80)]='/N'; s.cells.옛신규[d(1)]='D';
    A.recompute();
    const a={새내기:A.traineeUntil('새내기'), 옛신규:A.traineeUntil('옛신규'),
      지금:{새내기:A.isTrainee('새내기'), 옛신규:A.isTrainee('옛신규'), 선배:A.isTrainee('선배')},
      칩:A.newChip('새내기').includes('신규 ~'), 옛칩:A.newChip('옛신규')};
    s.newUntil.새내기=d(30); const b={until:A.traineeUntil('새내기')};
    s.cells.새내기[d(40)]='/N'; b.cellWins=A.traineeUntil('새내기')===d(40);
    delete s.cells.새내기[d(40)]; delete s.newUntil.새내기;
    return {a, b, d5:d(5), dm80:d(-80), d30:d(30)};`);
  eq('신규는 근무표의 마지막 /D 날까지', nw.a.새내기, nw.d5);
  eq('몇 달 전 /D 는 그 날에서 끝난다', nw.a.옛신규, nw.dm80);
  eq('오늘 신규인지', nw.a.지금, { 새내기: true, 옛신규: false, 선배: false });
  ok('간호사 관리 칩은 끝나는 날까지만', nw.a.칩 && nw.a.옛칩 === '', JSON.stringify(nw.a));
  eq('날짜를 늦게 정하면 그 날까지', nw.b.until, nw.d30);
  ok('근무표에 더 늦은 /D 가 오면 근무표가 이긴다', nw.b.cellWins);
  const nuEdit = await ev(`return (async()=>{ const A=window.__app; const s=A.store;
    const d=k=>{ const x=new Date(); x.setDate(x.getDate()+k); return A.isoOfD(x); };
    const p=A.editNewUntil('새내기'); await new Promise(r=>setTimeout(r,60));
    const box=document.querySelector('#modalBox');
    box.querySelector('input[name=nu][value=now]').click(); await new Promise(r=>setTimeout(r,20));
    const note=box.querySelector('#nuNote').textContent;
    box.querySelector('#mdOk').click(); await p;
    const res={note, cells:[d(-3),d(2),d(5),d(6)].map(k=>s.cells.새내기[k]), 지금:A.isTrainee('새내기'), nu:s.newUntil.새내기||null};
    A.undoAny(); res.undo=[d(2),d(5)].map(k=>s.cells.새내기[k]);
    return res; })()`);
  ok('오늘부터 떼기는 바뀔 날 수를 미리 알린다', nuEdit.note.includes('2일'), nuEdit.note);
  eq('오늘부터 떼면 앞으로의 /D·/E 는 D·E 로, 지난 기록은 그대로', nuEdit.cells, ['/D', 'E', 'D', 'D']);
  eq('뗀 뒤로는 신규가 아니다', [nuEdit.지금, nuEdit.nu], [false, null]);
  eq('Ctrl+Z 로 되돌아온다', nuEdit.undo, ['/E', '/D']);

  // ── 25. 교육·행사 일정 (2026-09-27) ────────────────────────────────────
  step('25 교육·행사 일정');
  const evs = await ev(`const A=window.__app; const s=A.store;
    s.evRules=[
      {id:'a',text:'CPR 교육',from:'2026-10-05',to:'2026-10-05'},
      {id:'b',text:'QI 발표 준비',from:'2026-10-06',to:'2026-10-08'},
      {id:'c',text:'주간 회의',from:'2026-10-01',to:'',wds:[1,3]},
      {id:'d',text:'감염 교육',from:'2026-10-01',to:'2026-10-31',wds:[2],skip:['2026-10-13']},
      {id:'e',text:'끝 없는 기간',from:'2026-10-01',to:''}];
    const t=iso=>A.eventText(iso);
    return {월:t('2026-10-05'), 화:t('2026-10-06'), 수:t('2026-10-07'), 목:t('2026-10-08'), 금:t('2026-10-09'),
      다음수:t('2026-10-14'), 끝없음:t('2026-11-02'), 뺀날:t('2026-10-13'), 다른화:t('2026-10-20'), 시작전:t('2026-09-28'),
      desc:[A.evDesc(s.evRules[0]),A.evDesc(s.evRules[1]),A.evDesc(s.evRules[2]),A.evDesc(s.evRules[3])]};`);
  eq('이 날만 + 매주 월', evs.월, 'CPR 교육\n주간 회의');
  eq('기간 + 매주 화', evs.화, 'QI 발표 준비\n감염 교육');
  eq('기간 + 매주 수', evs.수, 'QI 발표 준비\n주간 회의');
  eq('기간 끝날', evs.목, 'QI 발표 준비');
  eq('아무 일정 없는 날', evs.금, '');
  eq('매주 반복은 다음 주에도', evs.다음수, '주간 회의');
  eq('끝을 비우면 계속', evs.끝없음, '주간 회의');
  eq('이 날만 뺀 날', evs.뺀날, '');
  eq('뺀 날 말고는 그대로', evs.다른화, '감염 교육');
  eq('시작 전에는 없다', evs.시작전, '');
  eq('일정 설명', evs.desc, ['이 날만 · 10/05(월)', '기간 · 10/06(화)~10/08(목) · 3일',
    '매주 월·수 · 10/01부터 계속', '매주 화 · 10/01~10/31 · 3일 · 1일 뺌']);
  const evMig = await ev(`const A=window.__app; const s=A.store; const keep=s.evRules; s.evRules=[];
    s.events={'2026-10-02':'옛 행사','2026-10-01':'  '}; A.migrateStore();
    const out={rules:s.evRules.map(r=>[r.text,r.from,r.to]), events:s.events}; s.evRules=keep; return out;`);
  eq('옛 날짜별 글자는 이 날만 일정으로 옮긴다', evMig, { rules: [['옛 행사', '2026-10-02', '2026-10-02']], events: {} });
  const add = await ev(`return (async()=>{ const A=window.__app; const s=A.store; s.evRules=[];
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const p=A.editEventRule('2026-10-05',null); await wait(60);
    const box=document.querySelector('#modalBox');
    box.querySelector('#evText').value='병동 회의';
    box.querySelector('input[name=evm][value=week]').click();
    box.querySelector('.wdPick input[value="4"]').click();
    const to=box.querySelector('#evWTo'); to.value='2026-10-31'; to.dispatchEvent(new Event('input',{bubbles:true}));
    const note=box.querySelector('#evNote').textContent;
    box.querySelector('#mdOk').click(); await p;
    const r=s.evRules[0];
    const p2=A.editEventRule('2026-10-05',null); await wait(60);
    document.querySelector('#mdOk').click(); await wait(20);
    const err=document.querySelector('#mdErr').textContent; A.closeModal(null); await p2;
    s.cells.선배=s.cells.선배||{}; s.cells.선배['2026-10-05']='D'; A.recompute();   // 근무표가 없는 주는 표 대신 안내만 나온다
    A.wkSunday=new Date(2026,9,4); A.renderWeek();
    const cell=[...document.querySelectorAll('#wkTable td.evt')].find(t=>t.dataset.iso==='2026-10-05');
    const shown={글자:cell?cell.textContent:'', 반복표시:!!(cell&&cell.querySelector('.evRep'))};
    await A.buildPrintArea(false);
    const printed=(document.querySelector('#printArea')||{}).textContent.includes('병동 회의');
    const p3=A.openEventDay('2026-10-08'); await wait(60);
    [...document.querySelectorAll('#modalBox button')].find(b=>b.textContent.includes('병동 회의')).click(); await wait(60);
    [...document.querySelectorAll('#modalBox button')].find(b=>b.textContent.includes('만 빼기')).click(); await p3;
    const skipped={skip:s.evRules[0].skip, 목:A.eventText('2026-10-08'), 다음목:A.eventText('2026-10-15')};
    A.undoAny(); skipped.undo=A.eventText('2026-10-08');
    return {rule:[r.text,r.from,r.to,r.wds], note, err, n:s.evRules.length, shown, printed, skipped}; })()`);
  eq('매주 여러 요일로 넣는다', add.rule, ['병동 회의', '2026-10-05', '2026-10-31', [1, 4]]);
  ok('몇 날에 드는지 미리 알려 준다', add.note.includes('매주 월·목 · 10/05~10/31 · 8일'), add.note);
  eq('내용이 비면 넣지 않는다', [add.err, add.n], ['내용을 적으세요', 1]);
  ok('배정표 맨 윗줄에 반복 표시와 함께 나온다', add.shown.글자.includes('병동 회의') && add.shown.반복표시, JSON.stringify(add.shown));
  ok('인쇄물에도 나온다', add.printed);
  eq('반복 일정은 이 날만 뺄 수 있다', [add.skipped.skip, add.skipped.목, add.skipped.다음목], [['2026-10-08'], '', '병동 회의']);
  eq('뺀 것도 Ctrl+Z 로 되돌아온다', add.skipped.undo, '병동 회의');
  await ev(`const A=window.__app; A.store.evRules=[]; A.wkSunday=new Date(2026,8,6); return 1`);

  // ── 하루 어싸인표 (병동 한글 양식, 2026-09-27) ───────────────────────────
  // 양식 hwpx 를 그대로 두고 칸만 채운다. 칸 위치는 훑어서 찾는다 — 자리 줄은 위에서부터 차지·A·B…
  step('23 하루 어싸인표');
  const day = await ev(`const A=window.__app; return (async()=>{
    const s=A.store; s.cells={}; s.unit={}; s.relief={}; s.daily={}; s.evRules=[]; s.trainee={}; s.trOv={};
    s.order=['가간호','나간호','다간호','라간호','마간호','바간호','사간호'];
    const plan=['D','D','D','E','E','N','OF'];
    s.order.forEach((n,i)=>{ s.cells[n]={'2026-09-28':plan[i]}; });
    s.evRules=[{id:'x',text:'이름표 꽂기',from:'2026-09-28',to:'2026-09-28'},{id:'y',text:'부서 점검',from:'2026-09-28',to:'2026-09-28'},{id:'z',text:'셋째 공지',from:'2026-09-28',to:'2026-09-28'}];
    A.recompute(); A.DAYTPL=null;
    const T=await A.loadDayTpl();
    const L0=A.dayLayout(new DOMParser().parseFromString(T.sec,'application/xml'));
    const layout={제목:!!L0.title, 공지:L0.notices.length, 자리:L0.main.rows.length, 머리:Object.keys(L0.main.shifts), 당직:L0.fields.length, 기호:L0.bullet};
    const r=await A.buildDayDoc('2026-09-28'), L1=A.dayLayout(r.doc);   // 채운 뒤 다시 훑어 읽는다 (r.L 은 채우기 전 칸)
    const M=L1.main, txt=(row,col)=>{ const c=M.m.at(row,col); return c?c.text:null; };
    const info=A.dayInfo('2026-09-28'), cnt=P=>Object.keys(info[P].labels).length+info[P].extra.length;
    const seats=['D','E','N'].map(P=>M.rows.slice(0,cnt(P)).every((row,i)=>{ const lab=['차지','A','B','C','D','E'][i];
      return txt(row.r,M.shifts[P].nurse)===info[P].labels[lab] && txt(row.r,M.shifts[P].room)===A.roomsFor(P,cnt(P),lab,'2026-09-28'); }));
    const blankRest=M.rows.slice(cnt('N')).every(row=>txt(row.r,M.shifts.N.nurse)===''&&txt(row.r,M.shifts.N.room)==='');
    const fill={제목:A.hwText(L1.title), 공지:L1.notices.map(A.hwText), 자리:seats, 빈자리비움:blankRest, 경고:r.warn};
    // 당직: 안 적은 칸은 양식 그대로, 적은 칸은 줄바꿈이 lineBreak 로
    s.daily={'2026-09-28':{duty:{[r.L.fields[0].key]:'가나다'+String.fromCharCode(10)+'010-0000-0000'}}};
    const bytes=await A.dayHwpxBytes('2026-09-28');
    const ents=A.readZip(bytes), text=async n=>{ const e=ents.find(x=>x.name===n); return new TextDecoder().decode(e.meth===8?await A.inflateRaw(e.raw):e.raw); };
    const sec=await text('Contents/section0.xml'), doc=new DOMParser().parseFromString(sec,'application/xml');
    const L2=A.dayLayout(doc);
    const baseEnts=T.ents.map(e=>e.name);
    const zip={순서:JSON.stringify(ents.map(e=>e.name))===JSON.stringify(baseEnts), 첫항목:ents[0].name, 첫압축:ents[0].meth,
      XML:!doc.getElementsByTagName('parsererror').length, 줄바꿈:/<hp:t>가나다<hp:lineBreak\/>010-0000-0000<\/hp:t>/.test(sec),
      당직1:A.hwText(L2.fields[0].cell.sub.querySelector('*')), 당직2그대로:L2.fields[1].cell.text===L0.fields[1].def,
      제목캐시없음:!L2.title.getElementsByTagNameNS('*','linesegarray').length,
      문서제목:/9월 28일 어싸인표/.test(await text('Contents/content.hpf')), 미리보기글:(await text('Preview/PrvText.txt')).includes('가간호')};
    // 공지를 이 날만 고치면 일정 대신 그것이 나가고, 지우면 일정으로 돌아온다
    s.daily={'2026-09-28':{notes:'하나만'}};
    const own=A.dayLayout((await A.buildDayDoc('2026-09-28')).doc).notices.map(A.hwText);
    s.daily={};
    // 올린 양식 검사 — .hwp·엑셀은 이유를 말하고 거절한다
    const rej=async u8=>{ try{ await A.parseHwpx(u8); return 'ok'; }catch(e){ return e.message; } };
    const hwp=await rej(new Uint8Array([0xD0,0xCF,0x11,0xE0,0,0,0,0]));
    const xl=await rej(A.b64ToBytes(document.querySelector('#tplB64').textContent.replace(/[/][*][^*]*[*][/]/g,'').trim()));
    // 시작 안내 마지막 줄은 엑셀 내려받기 (사용자 2026-09-27)
    const ob=A.onboardItems().slice(-1)[0];
    s.evRules=[]; A.recompute();
    return {layout,fill,zip,own,hwp:/HWPX/.test(hwp),xl:/엑셀/.test(xl),ob:[ob.lb,ob.go,ob.goT]}; })();`);
  eq('기본 양식 구조를 찾는다', day.layout, { 제목: true, 공지: 2, 자리: 5, 머리: ['D', 'E', 'N'], 당직: 3, 기호: '★ ' });
  eq('제목은 그 날 날짜·요일', day.fill.제목, '9월 28일 (월)');
  eq('공지는 양식의 기본 공지 + 교육·행사 일정 — 줄 수만큼 늘어난다', day.fill.공지,
    ['★ 이름표 꽂기 (스테이션 및 1인, 2인실 병실 앞)', '★ 부서예방 점검 3PM 이전 시행', '★ 이름표 꽂기', '★ 부서 점검', '★ 셋째 공지']);
  eq('D·E·N 자리마다 배정표의 이름·방', day.fill.자리, [true, true, true]);
  ok('사람 없는 자리는 양식 예시 글자를 비운다', day.fill.빈자리비움);
  eq('경고 없음', day.fill.경고, []);
  eq('한글 파일 — zip 순서 그대로, mimetype 맨 앞 무압축', [day.zip.순서, day.zip.첫항목, day.zip.첫압축], [true, 'mimetype', 0]);
  ok('본문 XML 이 깨지지 않는다', day.zip.XML);
  ok('당직 줄바꿈은 lineBreak', day.zip.줄바꿈);
  ok('안 적은 당직 칸은 양식 그대로', day.zip.당직2그대로);
  ok('글자를 바꾼 문단은 줄 배치 캐시를 뗀다', day.zip.제목캐시없음);
  ok('문서 제목·미리보기 글도 그 날로', day.zip.문서제목 && day.zip.미리보기글, JSON.stringify(day.zip));
  eq('이 날만 고친 공지가 일정보다 앞선다', day.own, ['★ 하나만']);
  ok('.hwp 는 HWPX 로 저장하라고 알려 준다', day.hwp);
  ok('엑셀 파일은 한글 양식이 아니라고 알려 준다', day.xl);
  eq('시작 안내 마지막 줄 = 엑셀 내려받기', day.ob, ['엑셀로 내려받기', 'exportWeekXlsx()', '엑셀 다운로드']);

  // ── 당직표·번호 (2026-09-27) ────────────────────────────────────────────
  // 엑셀 당직표를 올리거나 붙이면 날짜별 당직·전화번호를 읽고, 하루 어싸인표 당직 칸을 날마다 채운다.
  // 표 모양은 병원·과마다 달라 자리를 가정하지 않고 훑는다 — 이름은 가짜, 번호는 010-0000-…
  step('24 당직표·번호');
  const duty = await ev(`const A=window.__app; return (async()=>{
    const s=A.store, NL=String.fromCharCode(10), TAB=String.fromCharCode(9);
    s.duty={}; s.daily={}; A.dutyStore();
    const tsv=rows=>rows.map(r=>r.join(TAB)).join(NL);
    // ① 달력형 xlsx (정형외과식) — 날짜 줄(날짜 서식) 아래 전공의·전문의 줄, 표 아래 이름·번호
    const X=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
    const col=n=>String.fromCharCode(65+n);
    const cells=[], put=(r,c,v,style)=>cells.push({r,c,v,style});
    put(1,0,'<< 정형외과 당직표 >>');
    ['일','월','화','수','목','금','토'].forEach((w,i)=>put(2,i+1,w));
    const wk=[[46264,['R1','R2','R3','R4','R1','R2','R3'],['','','텀체인지','','홍길동','','']],
              [46271,['R4','R1','R2','R3','R4','R1','R2'],['','','','','','','']]];
    let r=3;
    for(const [d0,res,att] of wk){ put(r,0,'날짜'); for(let i=0;i<7;i++) put(r,i+1,d0+i,1);
      put(r+1,0,'전공의'); res.forEach((v,i)=>put(r+1,i+1,v)); put(r+2,0,'전문의'); att.forEach((v,i)=>v&&put(r+2,i+1,v)); r+=3; }
    put(r+1,0,'R4 이순신'); put(r+1,1,'010-0000-0004'); put(r+2,0,'R1 박미경'); put(r+2,1,'01000000001'); put(r+3,0,'홍길동'); put(r+3,1,'010-0000-0010');
    const byRow={}; cells.forEach(x=>(byRow[x.r]=byRow[x.r]||[]).push(x));
    const sheet='<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+
      Object.keys(byRow).sort((a,b)=>a-b).map(rn=>'<row r="'+rn+'">'+byRow[rn].map(x=>typeof x.v==='number'
        ?'<c r="'+col(x.c)+rn+'" s="'+(x.style||0)+'"><v>'+x.v+'</v></c>'
        :'<c r="'+col(x.c)+rn+'" t="inlineStr"><is><t>'+X(x.v)+'</t></is></c>').join('')+'</row>').join('')+'</sheetData></worksheet>';
    const parts={'[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
      'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="2026-09" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/styles.xml':'<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="176" formatCode="mm&quot;월&quot;\\ dd&quot;일&quot;"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="176"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml':sheet};
    const u8=A.packXlsx({ents:Object.keys(parts).map(name=>({name}))},parts,0);
    const g=await A.readXlsxGrid(u8,{what:'당직표',isoDates:true});
    const os=A.parseDutyGrid(g,{sheetName:g.sheetName,ctx:{y:2025,m:1}});
    const osOut={시트:g.sheetName, 날짜:[os.dates[0],os.dates[os.dates.length-1],os.dates.length], 달:[os.ym.y,os.ym.m,os.ym.how],
      줄:os.rows.map(x=>[x.label,x.n]), 번호:os.book.map(b=>b.name+' '+b.phone)};
    // 넣기 — 가장 긴 줄(전공의)이 기본
    A.dutyUI.key='OS 당직'; A.dutyIngest(g,{src:'x.xlsx',sheetName:g.sheetName});
    const pick=A.dutyUI.pv.rows[A.dutyUI.pv.pick].label;
    A.dutyApply();
    const R=s.duty.roster['OS 당직'];
    const auto=['2026-09-02','2026-08-31','2026-09-03'].map(i=>{ const a=A.dutyAuto('OS 당직',i); return a&&[a.raw,a.text,!!a.m]; });
    // 하루 어싸인표 — 당직표로 채우고, 번호표에 없으면 확인에 알린다. 이 날 고친 글자가 먼저
    A.DAYTPL=null;
    const cellOf=async iso=>{ const b=await A.buildDayDoc(iso); const L=A.dayLayout(b.doc); return {t:L.fields[0].cell.text,w:b.warn.filter(x=>x.includes('OS 당직'))}; };
    const d2=await cellOf('2026-09-02'), d31=await cellOf('2026-08-31');
    s.daily={'2026-09-02':{duty:{'OS 당직':'손으로 적음'}}};
    const own=(await cellOf('2026-09-02')).t;
    s.daily={};
    // 번호가 바뀌면 — 번호표만 고치면 모든 날이 따라간다
    const i4=s.duty.book['OS 당직'].findIndex(b=>b.name==='R4 이순신');
    A.dutyUI.key='OS 당직'; A.dutySetBook(i4,'phone','01000009999');
    const changed=A.dutyAuto('OS 당직','2026-09-06').text;
    A.undoAny(); const undone=A.dutyAuto('OS 당직','2026-09-06').text;
    // ② 붙여넣기(외과식) — 날짜 칸이 1·2·3 뿐, 연·월은 제목에서, 30·31 은 지난달. 오른쪽 이름·번호 목록, R1a/이름 은 이름으로 찾는다
    const gs=A.parseDutyGrid(A.parseClipboard(tsv([
      ['','2026','','9월','외과'],
      ['','','30','31','1','2','3','4','5','','과','이름','번호'],
      ['','응급실','김영숙','','R1a/정다래','강민호','','','','','간담췌','정다래','010-0000-0020'],
      ['','병동/ICU','','','','','','','','','','강민호','010 0000 0021'],
      ['','','6','7','8','9','10','11','12'],
      ['','응급실','윤서영','임태균','','','','','']])),{ctx:{y:2025,m:1}});
    const gsOut={달:[gs.ym.y,gs.ym.m,gs.ym.how], 날짜:[gs.dates[0],gs.dates[gs.dates.length-1]], 줄:gs.rows.map(x=>[x.label,x.n]),
      넷째:gs.rows[0].byIso['2026-09-01'], 번호:gs.book.map(b=>b.name+' '+b.phone),
      찾기:[A.dutyMatchIn(gs.book,'R1a/정다래'),A.dutyMatchIn(gs.book,'강민호')].map(m=>m&&[m.name,m.b.phone])};
    // ③ 번호만 (머리 줄 이름·번호·내선) · ④ 세로 당직표 · ⑤ 일련번호 열은 날짜가 아니다 · ⑥ 달 넘김
    const only=A.parseDutyGrid(A.parseClipboard(tsv([['이름','번호','내선'],['홍길동','010-0000-0010','48001'],['김영숙','01000000011','']])));
    const vert=A.parseDutyGrid(A.parseClipboard(tsv([['날짜','OS 당직'],['9/1','R4'],['9/2','R1'],['9/3','홍길동']])),{ctx:{y:2026,m:9}});
    const cnt=A.parseDutyGrid(A.parseClipboard(tsv([['번호','이름','전화'],['1','홍길동','010-0000-0010'],['2','김영숙','010-0000-0011'],['3','이순신','010-0000-0012']])),{ctx:{y:2026,m:9}});
    const roll=A.parseDutyGrid(A.parseClipboard(tsv([['','28','29','30','1','2'],['당직','가','나','다','라','마']])),{ctx:{y:2026,m:9}});
    const rollOct=A.parseDutyGrid(roll.grid,{ym:{y:2026,m:10,how:'user'}});
    // 번호표 합치기 — 이름이 같으면 새 번호, 없던 이름은 뒤에, 지우지 않는다
    const mg=A.dutyMergeBook([{name:'홍길동',phone:'010-0000-0010',ext:''},{name:'최정훈',phone:'010-0000-0005',ext:''}],[{name:'홍길동',phone:'010-0000-0099',ext:''},{name:'한지민',phone:'010-0000-0006',ext:'48002'}]);
    // 모양 — {이름} {번호} {내선}. 번호가 없고 내선만 있으면 {번호} 자리에 #내선, 비어 버린 # 는 걷는다
    const fill=[A.dutyFill('{이름} #{내선}'+NL+'(20:00 ~ 익일 6am)','한지민',{phone:'',ext:'48002'}),
                A.dutyFill('{이름} #{내선}','최정훈',{phone:'010-0000-0005',ext:''}),
                A.dutyFill('{이름}'+NL+'{번호}','텀체인지',null),
                A.dutyFill('{이름}'+NL+'{번호}','한지민',{phone:'',ext:'48002'})];
    const out={osOut,pick,R:[R['2026-09-02'],R['2026-09-03'],Object.keys(R).length],auto,d2,d31,own,changed,undone,gsOut,
      only:[only.dates.length,only.book.map(b=>[b.name,b.phone,b.ext])],
      vert:[vert.dates,vert.rows.map(x=>[x.label,x.n])], cnt:[cnt.dates.length,cnt.book.length],
      roll:[roll.dates[0],roll.dates[4],roll.ym.how], rollOct:[rollOct.dates[0],rollOct.dates[4]],
      mg:[mg.book.map(b=>b.name+' '+b.phone),mg.added,mg.changed.map(c=>c.name+':'+c.from+'→'+c.to)], fill};
    s.duty={}; A.dutyStore();
    return out; })();`);
  eq('xlsx 당직표 — 날짜 서식 칸은 연도까지 읽는다', duty.osOut.날짜, ['2026-08-30', '2026-09-12', 14]);
  eq('달은 날짜 칸에서', duty.osOut.달, [2026, 9, 'date']);
  eq('날짜 줄 아래 줄 이름으로 나눈다 (줄마다 몇 날)', duty.osOut.줄, [['전공의', 14], ['전문의', 2]]);
  eq('표 아래 이름·번호를 번호표로 (번호 모양 맞춤)', duty.osOut.번호, ['R4 이순신 010-0000-0004', 'R1 박미경 010-0000-0001', '홍길동 010-0000-0010']);
  eq('가장 긴 줄이 기본', duty.pick, '전공의');
  eq('넣으면 날짜마다 당직표 글자 그대로', duty.R, ['R4', 'R1', 14]);
  eq('당직표 R4 → 번호표 R4 이순신 · 번호 / 번호표에 없는 R2 는 글자만', duty.auto,
    [['R4', 'R4 이순신\n010-0000-0004', true], ['R2', 'R2', false], ['R1', 'R1 박미경\n010-0000-0001', true]]);
  eq('하루 어싸인표 당직 칸이 저절로 채워진다', duty.d2, { t: 'R4 이순신\n010-0000-0004', w: [] });
  ok('번호표에 없는 당직은 확인에 알린다', duty.d31.t === 'R2' && duty.d31.w.length === 1 && duty.d31.w[0].includes('번호표에 없어'), JSON.stringify(duty.d31));
  eq('이 날 고친 글자가 당직표보다 먼저', duty.own, '손으로 적음');
  eq('번호가 바뀌면 번호표만 고치면 된다 (번호 모양도 맞춘다)', duty.changed, 'R4 이순신\n010-0000-9999');
  eq('번호 고친 것도 Ctrl+Z', duty.undone, 'R4 이순신\n010-0000-0004');
  eq('붙여넣기 — 연·월은 제목에서', duty.gsOut.달, [2026, 9, 'text']);
  eq('날짜만 있는 칸 — 첫 주 30·31 은 지난달', duty.gsOut.날짜, ['2026-08-30', '2026-09-12']);
  eq('줄 이름(응급실)으로 모은다', duty.gsOut.줄, [['응급실', 5]]);
  eq('R1a/이름 도 그대로 읽는다', duty.gsOut.넷째, 'R1a/정다래');
  eq('오른쪽 목록 — 머리 줄의 이름 열, 띄어 쓴 번호도', duty.gsOut.번호, ['정다래 010-0000-0020', '강민호 010-0000-0021']);
  eq('R1a/이름 → 그 이름의 번호, 이름은 당직표 글자 그대로', duty.gsOut.찾기, [['R1a/정다래', '010-0000-0020'], ['강민호', '010-0000-0021']]);
  eq('번호만 붙여도 된다 (내선 열까지)', duty.only, [0, [['홍길동', '010-0000-0010', '48001'], ['김영숙', '010-0000-0011', '']]]);
  eq('세로 당직표(날짜가 한 열)도 읽는다', duty.vert, [['2026-09-01', '2026-09-02', '2026-09-03'], [['OS 당직', 3]]]);
  eq('일련번호(번호 1·2·3) 열은 날짜로 읽지 않는다', duty.cnt, [0, 3]);
  eq('달 없는 28·29·30·1·2 — 보던 달 기준 앞은 지난달', duty.roll, ['2026-08-28', '2026-09-02', 'none']);
  eq('달을 고르면 다시 맞춘다', duty.rollOct, ['2026-09-28', '2026-10-02']);
  eq('번호표 합치기 — 같은 이름은 새 번호, 없던 이름은 뒤에', duty.mg,
    [['홍길동 010-0000-0099', '최정훈 010-0000-0005', '한지민 010-0000-0006'], 1, ['홍길동:010-0000-0010→010-0000-0099']]);
  eq('종이 모양 — 내선·시간, 빈 # 걷기, 번호 없으면 #내선', duty.fill,
    ['한지민 #48002\n(20:00 ~ 익일 6am)', '최정훈', '텀체인지', '한지민\n#48002']);

  // ── 기본 공지 · 당직 번호 · 양식 글자 고치기 (2026-09-27 저녁, 결정 2-36) ──────────
  // 병동마다 쓰는 양식이 달라 CN(48455) 같은 자리 이름·기본 공지·당직 칸 이름을 병동이 고쳐 데이터 파일에 저장한다
  step('26 기본 공지·당직 번호·양식 글자');
  const dfm = await ev(`const A=window.__app; return (async()=>{
    const s=A.store, NL=String.fromCharCode(10);
    s.daily={}; s.duty={}; A.dutyStore(); s.dayForm=null; A.DAYTPL=null;
    s.evRules=[{id:'a',text:'신규 교육',from:'2026-09-28',to:'2026-09-28'},{id:'b',text:'★ 부서예방 점검 3PM 이전 시행',from:'2026-09-28',to:'2026-09-28'}];
    const T=await A.loadDayTpl(), doc0=new DOMParser().parseFromString(T.sec,'application/xml'), L0=A.dayLayout(doc0);
    const K=L0.fields.map(f=>f.key);
    const notes={기본:L0.noticeDefs, 이날:A.dayNotes('2026-09-28',L0.noticeDefs).split(NL), 없는날:A.dayNotes('2026-09-29',L0.noticeDefs).split(NL)};
    // 당직 칸 문단 모양 — 양식에서 GS 칸만 줄 간격이 달랐다. 채운 칸은 가장 많은 모양으로 맞춘다
    const paraOf=f=>A.hwKids(f.cell.sub,'p')[0].getAttribute('paraPrIDRef');
    const before=L0.fields.map(paraOf);
    // GS = 늘 같은 번호 · 진료지원 = 번호표에 S-zone
    s.duty.lines[K[1]]={fixed:{phone:'010-0000-9999',ext:''}};
    s.duty.roster[K[1]]={'2026-09-28':'홍길동'};
    s.duty.book[K[2]]=[{name:'최세브',phone:'010-0000-0100',ext:'48001'},{name:'박세브',phone:'010-0000-0101',ext:'48002'}];
    s.duty.book[K[0]]=[{name:'R4 이순신',phone:'010-0000-0004',ext:''}];
    const name=[A.dayDutyName(K[2],'최세브'),A.dayDutyName(K[2],'최세브 #48001'),A.dayDutyName(K[2],'모르는 사람'),A.dayDutyName(K[1],'아무개')];
    s.duty.roster[K[2]]={'2026-09-28':'최세브'};
    const r=await A.buildDayDoc('2026-09-28'), L1=A.dayLayout(r.doc);
    const num={prefer:[A.dutyPrefer(K[0]),A.dutyPrefer(K[1]),A.dutyPrefer(K[2])], GS:L1.fields[1].cell.text, PA:L1.fields[2].cell.text,
      경고:r.warn.filter(w=>K.some(k=>w.includes(k)))};
    A.dutyUI.key=K[2]; A.dutySetPrefer('phone'); num.전화로=A.dutyAuto(K[2],'2026-09-28').text;
    A.undoAny(); num.되돌림=A.dutyAuto(K[2],'2026-09-28').text;
    num.토큰=A.dutyFill('{이름} {전화} {내선}','가',{phone:'010-0000-0001',ext:'48009'});
    const para={양식:before, 채움:L1.fields.map(paraOf), 기준:L0.dutyPara.para};
    // A4 한 장 — 공지가 늘면 빈 줄을 걷고, 두 줄(양식 그대로)이면 건드리지 않는다
    const pg=A.hwPage(doc0), limit=pg.H-pg.top-pg.bottom, top=d=>A.hwKids(d.documentElement,'p').length;
    const base=await A.buildDayDoc('2026-09-29');
    s.evRules=['하나','둘','셋'].map((t,i)=>({id:'f'+i,text:t+' 공지',from:'2026-09-30',to:'2026-09-30'}));
    const many=await A.buildDayDoc('2026-09-30'), Lm=A.dayLayout(many.doc);
    const fit={양식높이:A.hwBodyH(doc0,T.styles)<=limit, 그대로:top(base.doc)===top(doc0), 걷음:top(doc0)-top(many.doc),
      한장:A.hwBodyH(many.doc,T.styles)<=limit, 공지:Lm.notices.length, 표:!!Lm.main&&Lm.fields.length===K.length, 제목:!!Lm.title};
    // 양식 글자 고치기 — 자리 이름 CN(48455) · 기본 공지 · 당직 칸 이름. 당직 칸 이름이 바뀌면 그 칸 자료도 따라간다
    const box=document.createElement('div'); box.id='dayFormText'; document.body.appendChild(box);
    await A.renderDayFormText();
    const items=A.dayEditItems(doc0,L0), seat0=items.find(x=>x.g==='seat'&&x.seat===0), dut=items.find(x=>x.g==='duty'&&x.first&&x.text.split(NL)[0]===K[0]);
    const set=(id,v)=>{ const el=box.querySelector('[data-ed="'+id+'"]'); el.value=v; };
    const ed={자리:seat0&&seat0.text, 칸:box.querySelectorAll('[data-ed]').length>5};
    set(seat0.id,'CN(40000)'); set('n',notes.기본.join(NL)+NL+'세 번째 공지');
    set(dut.id,dut.text.replace(K[0],'정형 당직'));
    await A.saveDayFormText();
    A.DAYTPL=null;
    const T2=await A.loadDayTpl(), doc2=new DOMParser().parseFromString(T2.sec,'application/xml'), L2=A.dayLayout(doc2);
    ed.저장=[!!s.dayForm&&s.dayForm.edited, T2.name];
    ed.새자리=A.dayEditItems(doc2,L2).find(x=>x.g==='seat'&&x.seat===0).text;
    ed.새공지=L2.noticeDefs; ed.새칸=L2.fields[0].key;
    ed.옮김=[!!s.duty.book['정형 당직'],!s.duty.book[K[0]]];
    // 저장한 양식은 빈 줄을 그대로 두고(고치기 전 높이를 기억) 그 날 종이에서만 걷는다
    const d2=await A.buildDayDoc('2026-09-29');
    ed.한장=[T2.baseH>0, A.hwBodyH(d2.doc,T2.styles)<=limit, A.dayLayout(d2.doc).notices.length];
    // 이름을 비우거나 '중간·헬퍼' 를 넣은 자리는 저장하지 않는다
    await A.renderDayFormText();
    const it2=A.dayEditItems(doc2,L2).find(x=>x.g==='seat'&&x.seat===1);
    const f0=s.dayForm.b64; set(it2.id,'중간번'); await A.saveDayFormText();
    ed.막음=[s.dayForm.b64===f0, /자리 줄로 보지 않습니다/.test((box.querySelector('#dfEdMsg')||{}).textContent||'')];
    A.undoAny();   // 막힌 저장은 되돌리기에 남지 않는다 — 한 번 되돌리면 이름 바꾼 저장 전(양식·당직 칸 이름)으로
    ed.되돌림=[!s.dayForm||!s.dayForm.b64, !!s.duty.book[K[0]]];
    box.remove(); s.dayForm=null; A.DAYTPL=null; s.duty={}; A.dutyStore(); s.evRules=[]; s.daily={};
    return {notes,num,name,para,fit,ed}; })();`);
  eq('기본 공지 = 양식의 ★ 줄', dfm.notes.기본, ['이름표 꽂기 (스테이션 및 1인, 2인실 병실 앞)', '부서예방 점검 3PM 이전 시행']);
  eq('기본 공지 뒤에 그 날 교육·행사 — 같은 글은 한 번', dfm.notes.이날,
    ['이름표 꽂기 (스테이션 및 1인, 2인실 병실 앞)', '부서예방 점검 3PM 이전 시행', '신규 교육']);
  eq('일정이 없는 날도 기본 공지는 나간다', dfm.notes.없는날, ['이름표 꽂기 (스테이션 및 1인, 2인실 병실 앞)', '부서예방 점검 3PM 이전 시행']);
  ok('양식에선 당직 칸 문단 모양이 달랐다 (GS 줄 간격)', new Set(dfm.para.양식).size > 1, JSON.stringify(dfm.para));
  ok('채운 당직 칸은 모두 같은 문단 모양', dfm.para.채움.every(p => p === dfm.para.기준), JSON.stringify(dfm.para));
  eq('칸이 먼저 쓰는 번호 — OS 전화 · GS 늘 같은 번호(전화) · 진료지원 내선', dfm.num.prefer, ['phone', 'phone', 'ext']);
  eq('GS — 누가 당직이든 늘 같은 번호', dfm.num.GS, '홍길동\n010-0000-9999');
  eq('진료지원 — 이름만 적으면 S-zone 번호', dfm.num.PA, '최세브\n#48001');
  eq('늘 같은 번호·번호표에 있는 사람은 번호 경고 없음', dfm.num.경고, []);
  eq('전화번호 먼저로 바꾸면 전화번호', dfm.num.전화로, '최세브\n010-0000-0100');
  eq('바꾼 것도 Ctrl+Z', dfm.num.되돌림, '최세브\n#48001');
  eq('{전화} {내선} 은 그것만', dfm.num.토큰, '가 010-0000-0001 48009');
  eq('이름만 적은 칸 → 당직표로 (번호가 든 글·번호표에 없는 이름은 아님, 늘 같은 번호 칸은 아무 이름이나)', dfm.name, ['최세브', null, null, '아무개']);
  ok('양식은 A4 한 장', dfm.fit.양식높이);
  ok('공지가 두 줄이면 빈 줄을 건드리지 않는다', dfm.fit.그대로);
  ok('공지가 늘면 빈 줄을 걷어 A4 한 장', dfm.fit.걷음 > 0 && dfm.fit.한장, JSON.stringify(dfm.fit));
  eq('걷어도 제목·공지·표는 그대로', [dfm.fit.제목, dfm.fit.공지, dfm.fit.표], [true, 5, true]);
  eq('양식 글자 고치기 — 첫 자리 이름', dfm.ed.자리, 'CN(48455)');
  ok('고칠 칸이 여럿 보인다', dfm.ed.칸);
  eq('이 병동 양식으로 저장', dfm.ed.저장, [true, '101병동 기본 양식 (글자 고침)']);
  eq('자리 이름의 내선 번호를 고친다', dfm.ed.새자리, 'CN(40000)');
  eq('기본 공지를 늘린다', dfm.ed.새공지, ['이름표 꽂기 (스테이션 및 1인, 2인실 병실 앞)', '부서예방 점검 3PM 이전 시행', '세 번째 공지']);
  eq('당직 칸 이름을 바꾸면 번호표도 새 이름으로', [dfm.ed.새칸, dfm.ed.옮김], ['정형 당직', [true, true]]);
  eq('공지를 늘려 저장해도 그 날 종이는 A4 한 장', dfm.ed.한장, [true, true, 3]);
  eq("자리 이름에 '중간'이 들어가면 저장하지 않고 이유를 말한다", dfm.ed.막음, [true, true]);
  eq('저장한 양식도 Ctrl+Z (당직 칸 이름까지)', dfm.ed.되돌림, [true, true]);

  step('26b 하루 어싸인표 — 여러 줄 공지·쪽 나눔·당직 칸');
  const rv = await ev(`const A=window.__app; return (async()=>{
    const s=A.store, NL=String.fromCharCode(10);
    s.daily={}; s.duty={}; A.dutyStore(); s.dayForm=null; A.DAYTPL=null; s.evRules=[];
    // 한 ★ 안에서 줄을 바꾼 공지 — 글 칸에선 둘째 줄을 띄워 보이고, 다시 읽으면 한 공지
    const x=['가 공지'+NL+'이어지는 줄','다 공지'], shown=x.map(A.dayNoteShow).join(NL);
    const note={왕복:A.dayNoteSplit(shown), 새줄:A.dayNoteSplit('★ 하나'+NL+' 둘'+NL+'셋')};
    s.daily['2026-09-29']={notes:shown};
    const r=await A.buildDayDoc('2026-09-29'), L=A.dayLayout(r.doc);
    note.종이=L.notices.map(p=>A.hwText(p));
    s.daily={};
    // 쪽 나누기 뒤는 둘째 장 — 높이에 넣지 않고, 빈 줄이어도 걷지 않는다
    const T=await A.loadDayTpl(), doc=new DOMParser().parseFromString(T.sec,'application/xml');
    const h=A.hwBodyH(doc,T.styles), top=A.hwKids(doc.documentElement,'p'), blank=top.find(p=>A.hwBlankPara(p));
    const pb=blank.cloneNode(true); pb.setAttribute('pageBreak','1'); doc.documentElement.appendChild(pb);
    doc.documentElement.appendChild(top[0].cloneNode(true));
    const pg={높이같음:A.hwBodyH(doc,T.styles)===h, 첫장:A.hwPage1(doc).length===top.length, 나눔은빈줄아님:A.hwBlankPara(pb),
      양식빈줄보임:top.filter(p=>A.hwBlankPara(p)).some(p=>A.hwParaVisible(p,T.styles))};
    // 당직 칸 — 'R4' 처럼 연차만 적어도 번호표 사람, 칸 이름을 옛 칸 이름으로 바꾸면 합친다, 늘 같은 번호를 껐다 켜도 번호는 남는다
    const K=A.dayLayout(doc).fields.map(f=>f.key);
    s.duty.book[K[0]]=[{name:'R4 이순신',phone:'010-0000-0004',ext:''}];
    const duty={R4:A.dayDutyName(K[0],'R4'), 번호:A.dayDutyName(K[0],'R4 010-0000-0004')};
    s.duty.book['옛 칸']=[{name:'가',phone:'010-0000-0011',ext:''}];
    s.duty.book['새 칸']=[{name:'나',phone:'010-0000-0012',ext:''},{name:'가',phone:'010-0000-0099',ext:''}];
    A.dutyRenameKeys([['옛 칸','새 칸']]);
    duty.합침=[!s.duty.book['옛 칸'], s.duty.book['새 칸'].map(b=>b.name+' '+b.phone)];
    A.dutyUI.key=K[1]; s.duty.lines[K[1]]={fixed:{phone:'010-0000-9999',ext:''}};
    A.dutySetFixedOn(false); duty.끔=[!A.dutyFixed(K[1]), s.duty.lines[K[1]].fixed.phone];
    A.dutySetFixedOn(true); duty.켬=(A.dutyFixed(K[1])||{}).phone;
    s.duty={}; A.dutyStore(); A.DAYTPL=null;
    return {note,pg,duty}; })();`);
  eq('여러 줄 공지 — 글 칸에서 다시 읽어도 한 공지', rv.note.왕복, ['가 공지\n이어지는 줄', '다 공지']);
  eq('앞을 띄운 줄은 윗 공지에 이어지고, 붙인 줄은 새 공지', rv.note.새줄, ['하나\n둘', '셋']);
  eq('종이에도 한 ★ 문단 안에서 줄바꿈', rv.note.종이, ['★ 가 공지\n이어지는 줄', '★ 다 공지']);
  eq('쪽 나누기 뒤(둘째 장)는 한 장 높이에 넣지 않고 걷지도 않는다', rv.pg, {높이같음: true, 첫장: true, 나눔은빈줄아님: false, 양식빈줄보임: false});
  eq("당직 칸에 'R4'만 적어도 번호표 사람으로 (번호를 적으면 그대로)", [rv.duty.R4, rv.duty.번호], ['R4', null]);
  eq('당직 칸 이름을 이미 있는 칸 이름으로 바꾸면 번호표를 합친다 (옮겨 온 번호가 이김)', rv.duty.합침,
    [true, ['가 010-0000-0011', '나 010-0000-0012']]);
  eq('늘 같은 번호를 꺼도 적어 둔 번호는 남고, 다시 켜면 돌아온다', [rv.duty.끔, rv.duty.켬], [[true, '010-0000-9999'], '010-0000-9999']);

  // ── 27. 배정표 양식 자동 맵핑 ─────────────────────────────────────────────
  // 올린 양식에 자리표시자를 양식 모양대로 꽂는다(autoMap). 내장 서식 채우기와 **같은 칸에 같은 값**이어야
  // 자동 맵핑을 믿고 올린 양식을 채울 수 있다 — 칸 하나라도 다르면 종이에서 그 자리가 틀린다 (2026-09-28).
  step('27 양식 자동 맵핑');
  const setupWeek = `const setup=(id)=>{ A.setFormId(id); A.setWard(id); const s=A.store;
      const days=['2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11'];
      const D=['김차지','이에이','박비','최씨','정디','한이'], E=['오차지','유에이','문비','장씨','배디'], N=['정야간','한야간','오야간'];
      s.order=[...D,...E,...N,'중간이','신규일','가에스유','나에스유','다에스유'];
      s.cells={}; for(const n of s.order) s.cells[n]={};
      days.forEach((iso,i)=>{ D.forEach((n,k)=>{ if(!(i===1&&k===5)) s.cells[n][iso]=k===0?'DC':'D'; });
        E.forEach((n,k)=>{ s.cells[n][iso]=k===0?'EC':'E'; }); N.forEach((n,k)=>{ s.cells[n][iso]=k===0?'NC':'N'; });
        if(i%2===0) s.cells['중간이'][iso]='중';
        if(id==='82'){ s.cells['가에스유'][iso]='D'; s.cells['나에스유'][iso]='E'; s.cells['다에스유'][iso]='N'; } });
      s.cells['신규일']['2026-09-07']='/D';
      s.unit=id==='82'?{가에스유:'SU',나에스유:'SU',다에스유:'SU'}:{};
      s.trainee={'신규일':{pre:'이에이'}};
      s.evRules=[{id:'e1',text:'간호부 교육',from:'2026-09-08',to:'2026-09-08'},{id:'e2',text:'CPR 훈련',from:'2026-09-10',to:'2026-09-10'}];
      A.store=s; A.recompute(); };`;
  const par = await ev(`const A=window.__app; ${setupWeek}
    return (async()=>{ const out={};
      for(const id of ['101','102','82']){ setup(id);
        const tpl=await A.loadBaseTemplate(id), cells=A.sheetCells(tpl), merges=A.sheetMerges(tpl);
        const days=A.weekData(new Date(2026,8,6)), L=A.layoutOf(A.formDefOf(id),cells,merges);
        const x1=id==='101'?A.fillForm101(tpl,days):id==='102'?A.fillForm102(tpl,L,days):A.fillForm82(tpl,L,days);
        const sh=A.detectFormShape(cells,merges), am=A.autoMap(tpl,sh);
        if(!am.ok){ out[id]={err:am.why}; continue; }
        const t2={...tpl,sheetXml:am.xml}, c2=A.sheetCells(t2);
        const x2=A.fillByPlaceholders(t2,c2,A.layoutOf({kind:sh.kind},c2,merges),days,{dateXf:await A.dateStyleSet(tpl)});
        const a=A.sheetCells({...tpl,sheetXml:x1}), b=A.sheetCells({...tpl,sheetXml:x2});
        const diff=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]);
        out[id]={same:x1===x2, diff:diff.slice(0,6), missing:am.missing, cells:b};
      }
      return out; })()`);
  for (const id of ['101', '102', '82']) {
    ok(`${id} — 자동 맵핑으로 채운 엑셀이 내장 서식 채우기와 칸마다 같다`, par[id] && par[id].same && !par[id].diff.length,
      JSON.stringify(par[id] && (par[id].err || par[id].diff)));
    eq(`${id} — 자동 맵핑이 못 찾은 자리 없음`, par[id] && par[id].missing, []);
  }
  const c101 = par['101'].cells, c102 = par['102'].cells, c82 = par['82'].cells;
  ok('시험 주가 빈 주가 아니다 (날짜·차지·신규·중간번·교육)',
    /^[0-9]{5}$/.test(c101.D3) && c101.E5 === '김차지' && /신규일/.test(c101.G6) && c101.H10 === '중간이' && c101.H4 === '간호부 교육',
    JSON.stringify([c101.D3, c101.E5, c101.G6, c101.H10, c101.H4]));
  eq('102 — 차지 이름 뒤 /CRN', c102.F5, '김차지 /CRN');
  eq('82 — SU 칸 · 날짜 글자', [c82.E6, c82.E3], ['가에스유', '9월 7일']);
  // 82 원본의 13행은 A13:E13 '<교육 및 행사 일정>' · F13:J13 '<인계사항>' 두 상자다.
  // 예전 채우기는 D13~J13 을 비우고 써서 인계사항이 내보낼 때마다 지워지고 일정은 가려진 칸에 들어갔다.
  ok('82 — 인계사항 상자가 그대로 남는다', /^<인계사항>/.test(c82.F13 || ''), JSON.stringify(c82.F13));
  eq('82 — 교육·행사는 이름표 상자에 그 주 목록으로', (c82.A13 || '').split(String.fromCharCode(10)),
    ['<교육 및 행사 일정>', '9/8(화) 간호부 교육', '9/10(목) CPR 훈련']);
  eq('82 — 가려진 칸(G13)에 쓰지 않는다', c82.G13 || '', '');

  const exp82 = await ev(`const A=window.__app; ${setupWeek} setup('82');
    return (async()=>{ const r=await A.buildWeekXlsx(new Date(2026,8,6)); const c=A.sheetCells({...r.tpl,sheetXml:r.xml});
      return {F13:c.F13||'', A13:c.A13||''}; })()`);
  ok('82 내보내기(buildWeekXlsx)도 인계사항을 지우지 않는다', /^<인계사항>/.test(exp82.F13) && /간호부 교육/.test(exp82.A13), JSON.stringify(exp82));

  // 올린 101 양식(칸이 같아도)은 자동 맵핑 길로 채운다 — 결과가 고정 위치 채우기와 같아야 한다
  const ov101 = await ev(`const A=window.__app; ${setupWeek} setup('101');
    return (async()=>{ const b64=document.querySelector('#tplB64').textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
      A.store.forms['101']={name:'올린 101.xlsx',b64,savedAt:5,ph:false};
      const r=await A.buildWeekXlsx(new Date(2026,8,6));
      const base=await A.loadBaseTemplate('101');
      const x1=A.fillForm101(base,A.weekData(new Date(2026,8,6)));
      const a=A.sheetCells({...base,sheetXml:x1}), b=A.sheetCells({...r.tpl,sheetXml:r.xml});
      const diff=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]);
      delete A.store.forms['101'];
      return diff; })()`);
  eq('올린 101 양식 — 자동 맵핑 길의 결과가 고정 위치 채우기와 같다', ov101, []);

  // 자리표시자 양식(자동 맵핑을 내려받아 다시 올린 것)은 적힌 대로 채우고, 화면 인쇄 틀 대신 엑셀로 인쇄한다
  const tagged = await ev(`const A=window.__app; ${setupWeek} setup('102');
    return (async()=>{ const base=await A.loadBaseTemplate('102'), am=A.autoMap(base);
      const bytes=A.packXlsx(base,{'xl/worksheets/sheet1.xml':am.xml});
      A.store.forms['102']={name:'자리표시자.xlsx',b64:A.bytesToB64(bytes),savedAt:6,ph:true};
      const r=await A.buildWeekXlsx(new Date(2026,8,6)); const c=A.sheetCells({...r.tpl,sheetXml:r.xml});
      const out={F5:c.F5, F3:c.F3, 남은표시자:Object.values(c).filter(v=>/[{][{]/.test(v)).length, 인쇄:A.canPrint()};
      delete A.store.forms['102']; return out; })()`);
  eq('자리표시자 양식 — 적힌 대로 채우고 표시자가 남지 않는다 (날짜는 엑셀 날짜)',
    [tagged.F5, /^[0-9]{5}$/.test(String(tagged.F3)), tagged.남은표시자], ['김차지 /CRN', true, 0]);
  eq('자리표시자 양식은 화면 인쇄 대신 엑셀', tagged.인쇄, false);

  // ── 27b. 병동 양식 저장 ────────────────────────────────────────────────
  step('27b 병동 양식 저장');
  const wf = await ev(`const A=window.__app;
    return (async()=>{ const out={};
      const b82=document.querySelector('#tplB64_82').textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
      const s=A.store; s.ward='55'; s.wardPicked=true; s.rooms=A.wardRooms('55').map(r=>[r,4]); s.formId='101'; s.forms={};
      A.store=s; A.migrateStore(); A.show('admin'); A.pickAdmin('form');
      await A.checkFormFile({files:[new File([A.b64ToBytes(b82)],'55병동.xlsx')],value:''});
      const rep=document.querySelector('#formReport'); out.안내=rep?(rep.textContent||'').trim().slice(0,60):'(보고 칸 없음)';
      A.useCheckedForm();
      out.처음=[A.store.formId, A.store.forms['55'].kind, A.unitSlotName()];
      // 파일을 다시 열면(migrateStore) 병동 양식이 그대로여야 — 예전엔 내장 4벌만 보고 101 로 되돌렸다
      A.migrateStore(); out.다시열기=A.store.formId;
      // 같은 병동이 다시 올려도 모양을 잃지 않는다
      await A.checkFormFile({files:[new File([A.b64ToBytes(b82)],'55병동 새판.xlsx')],value:''});
      A.useCheckedForm(); out.다시올림=[A.store.forms['55'].kind, A.store.forms['55'].unitSlot, A.store.forms['55'].name];
      // 문구를 고쳐 저장해도 모양을 잃지 않는다
      await A.openFormText();
      const ta=[...document.querySelectorAll('#formText textarea')];
      out.인계사항고칠수있음=ta.some(t=>t.dataset.ref==='F13'&&!t.readOnly);
      out.요일잠금=ta.filter(t=>/^[D-J]2$/.test(t.dataset.ref)).every(t=>t.readOnly);
      const t1=ta.find(t=>t.dataset.ref==='A1'); t1.value='업무분담 (고침)'; await A.saveFormText();
      out.고친뒤=[A.store.forms['55'].kind, A.store.forms['55'].unitSlot, A.formDef().name];
      // 병동 양식이 없어진 파일: 병동 서식 → 없으면 101
      s.formId='77'; s.ward='102'; A.migrateStore(); out.병동서식으로=A.store.formId;
      s.formId='77'; s.ward='61'; A.migrateStore(); out.없으면101=A.store.formId;
      // 구조를 바꾸는 글자 고치기는 저장하지 않는다 (101: 화재발생시 → 중간번 이면 중간번 줄이 바뀐다)
      A.setWard('101'); A.setFormId('101'); delete A.store.forms['101'];
      await A.openFormText();
      const a31=[...document.querySelectorAll('#formText textarea')].find(t=>t.dataset.ref==='A31');
      a31.value='중간번'; await A.saveFormText(); out.구조바뀜저장안함=!A.formOv('101');
      A.store.forms={}; A.setWard('101'); A.setFormId('101'); A.show('week');
      return out; })()`);
  ok('새 병동 양식 — 지금 서식과 견주지 않고 그 병동 서식으로 안내', /^55병동 서식으로 쓸 수 있습니다/.test(wf.안내), JSON.stringify(wf));
  eq('새 병동 양식이 그 병동 서식이 된다 (82 모양 · SU 칸)', wf.처음, ['55', '82', 'SU']);
  eq('다시 열어도 병동 양식을 쓴다', wf.다시열기, '55');
  eq('다시 올려도 모양이 남는다', wf.다시올림, ['82', 'SU', '55병동 새판.xlsx']);
  eq('문구를 고쳐도 모양이 남는다', wf.고친뒤, ['82', 'SU', '55병동 양식']);
  ok('82 인계사항 문구를 고칠 수 있고 요일은 잠겨 있다', wf.인계사항고칠수있음 && wf.요일잠금, JSON.stringify(wf));
  eq('병동 양식이 없어진 파일은 그 병동 서식으로', wf.병동서식으로, '102');
  eq('그 병동 서식도 없으면 101', wf.없으면101, '101');
  eq('구조 인식을 바꾸는 문구는 저장하지 않는다', wf.구조바뀜저장안함, true);

  // ── 27c. 칸 쓰기 ─────────────────────────────────────────────────────────
  // 없는 칸을 줄 맨 앞에 끼우면 엑셀이 '복구'를 묻는다. 줄이 없으면 예전엔 조용히 안 썼다.
  step('27c 칸 쓰기');
  const pc = await ev(`const A=window.__app;
    const xml='<worksheet><sheetData><row r="2"><c r="B2" s="1"/><c r="D2"><v>1</v></c></row><row r="5"/></sheetData></worksheet>';
    const refs=x=>[...x.matchAll(/<c r="([A-Z]+[0-9]+)"/g)].map(m=>m[1]);
    return {열순서:refs(A.setCellStr(xml,'C2','가')), 새줄:refs(A.setCellStr(xml,'A3','나')), 끝줄:refs(A.setCellStr(xml,'E9','다')),
      빈줄:refs(A.setCellStr(xml,'B5','라')), 달러:A.sheetCells({sheetXml:A.setCellStr(xml,'D2','$&x'),sst:[]}).D2,
      날짜모양:['9월 13일','09/13','2026-09-13'].map(A.dateFmtOf), 날짜:A.fmtDateTok(new Date(2026,8,6),'YYYY년 MM월 DD일 M/D')};`);
  eq('없는 칸은 열 순서대로 끼운다', pc.열순서, ['B2', 'C2', 'D2']);
  eq('없는 줄은 줄 순서대로 만든다', [pc.새줄, pc.끝줄, pc.빈줄], [['B2', 'D2', 'A3'], ['B2', 'D2', 'E9'], ['B2', 'D2', 'B5']]);
  eq("이름에 '$&' 가 있어도 그대로 쓴다", pc.달러, '$&x');
  eq('양식에 적힌 날짜에서 글자 모양을 읽는다', pc.날짜모양, ['M월 D일', 'MM/DD', 'YYYY-MM-DD']);
  eq('날짜 글자 모양', pc.날짜, '2026년 09월 06일 9/6');

  // ── 27d. 교차 검토에서 나온 것들 ───────────────────────────────────────────
  // 자동 맵핑 PR 을 네 갈래(채우기 대조·xlsx 유효성·저장 호환·화면 흐름)로 따로 검토해 재현한 것들 (2026-09-28).
  step('27d 양식 검토 회귀');
  const rv27 = await ev(`const A=window.__app; ${setupWeek}
    const b64Of=id=>document.querySelector(id==='101'?'#tplB64':'#tplB64_'+id).textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
    const rawCells=x=>{ const o={}; for(const m of x.matchAll(/<c r="([A-Z]+[0-9]+)"[^>]*?(?:[/]>|>[^]*?<[/]c>)/g)) o[m[1]]=m[0]; return o; };
    const cellDiff=(x1,x2,tpl)=>{ const a=A.sheetCells({...tpl,sheetXml:x1}), b=A.sheetCells({...tpl,sheetXml:x2});
      return [...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>a[k]!==b[k]); };
    const reXml=async(tpl,xml)=>A.parseXlsx(A.packXlsx(tpl,{'xl/worksheets/sheet1.xml':xml}));
    const upload=(id,xmlTpl)=>{ A.store.forms[id]={name:'올린.xlsx',b64:A.bytesToB64(A.packXlsx(xmlTpl.tpl,{'xl/worksheets/sheet1.xml':xmlTpl.xml})),savedAt:9,ph:!!xmlTpl.ph,kind:xmlTpl.kind}; A.setFormId(id); };
    const sun=new Date(2026,8,6);
    return (async()=>{ const out={};
      // ① 101 날짜 줄이 빈 양식(병동이 주는 빈 양식) — {{날짜}} 가 요일 칸을 덮고 일요일만 채우던 것
      setup('101');
      { const base=await A.loadBaseTemplate('101');
        const xml=base.sheetXml.replace(/<c r="([D-Q])3"([^>]*?)(?:[/]>|>[^]*?<[/]c>)/g,(m,c,at)=>'<c r="'+c+'3"'+at.replace(/ t="[^"]*"/,'')+'/>');
        upload('101',{tpl:base,xml,kind:'101'});
        const r=await A.buildWeekXlsx(sun), x1=A.fillForm101(base,A.weekData(sun));
        out.빈날짜줄=cellDiff(x1,r.xml,base); delete A.store.forms['101']; }
      // ② 102 '대체' 줄 — 양식 자리 밖 D 근무자가 대체 줄에 (fillForm102 와 같게)
      setup('102');
      { const base=await A.loadBaseTemplate('102');
        const t2={...base,sheetXml:A.setCellStr(A.setCellStr(A.setCellStr(base.sheetXml,'A9','대체'),'D9','지난주 대체'),'F9','지난주 대체')};
        const c=A.sheetCells(t2), m=A.sheetMerges(t2), L=A.layoutOf({kind:'102'},c,m), days=A.weekData(sun);
        const x1=A.fillForm102(t2,L,days), am=A.autoMap(t2), t3={...t2,sheetXml:am.xml}, c3=A.sheetCells(t3);
        const x2=A.fillByPlaceholders(t3,c3,A.layoutOf({kind:'102'},c3,m),days,{dateXf:await A.dateStyleSet(t2)});
        out.대체줄={subRow:L.subRow, diff:cellDiff(x1,x2,t2), D9:A.sheetCells({...t2,sheetXml:x2}).D9||''}; }
      // ③ 날짜 예시의 요일·두 자리 연도
      out.날짜모양=['9/13(일)','26.09.13','2026.09.13 (일)','9월 13일 일요일'].map(A.dateFmtOf);
      out.날짜글자=['M/D(aaa)','YY.MM.DD','M월 D일 aaaa'].map(f=>A.fmtDateTok(new Date(2026,8,7),f));
      // ④ 방 칸이 있는 양식에 SU 자리 — 병동 자리로 꽂지 않는다
      setup('101');
      { const base=await A.loadBaseTemplate('101'), t2={...base,sheetXml:A.setCellStr(base.sheetXml,'C9','SU')};
        const c=A.sheetCells(t2), m=A.sheetMerges(t2), sh=A.detectFormShape(c,m), am=A.autoMap(t2,sh), c2=A.sheetCells({...t2,sheetXml:am.xml});
        const row9=Object.keys(c2).filter(k=>/^[D-Q]9$/.test(k)).map(k=>c2[k]).join(' ');
        out.SU={kind:sh&&sh.kind, row9, 자리수:(am.found||[]).filter(f=>/^D /.test(f)).join(',')}; }
      // ⑤ 문구 고치기 — 여러 줄 칸(CRLF)을 고친 칸으로 보고 조각 서식을 지우던 것: A1 만 고치면 A1 만 바뀐다
      { const b82=b64Of('82'); const s=A.store; s.ward='55'; s.wardPicked=true; s.rooms=A.wardRooms('55').map(r=>[r,4]); s.formId='101'; s.forms={};
        A.store=s; A.migrateStore(); A.show('admin'); A.pickAdmin('form');
        await A.checkFormFile({files:[new File([A.b64ToBytes(b82)],'55병동.xlsx')],value:''}); A.useCheckedForm();
        await A.openFormText();
        const t1=[...document.querySelectorAll('#formText textarea')].find(t=>t.dataset.ref==='A1'); t1.value='업무분담 (고침)'; await A.saveFormText();
        const before=rawCells((await A.loadBaseTemplate('82')).sheetXml), after=rawCells((await A.parseXlsx(A.b64ToBytes(A.store.forms['55'].b64))).sheetXml);
        out.문구고침=Object.keys({...before,...after}).filter(k=>before[k]!==after[k]);
        // ⑥ 검사 결과는 병동을 바꾸면 사라진다 (검사할 때의 병동 이름으로 다른 병동에 저장되던 것)
        await A.checkFormFile({files:[new File([A.b64ToBytes(b82)],'55병동.xlsx')],value:''});
        const had=!!window.__checkedForm; A.setWard('61');
        out.검사결과={had, after:!!window.__checkedForm, 글:((document.querySelector('#formReport')||{}).textContent||'').includes('55병동')};
        A.store.forms={}; A.setWard('101'); A.setFormId('101'); A.show('week'); }
      // ⑦ 82 이름표 상자의 조각 서식(빨간 굵은 제목)을 지키고, 인계사항 상자가 첫 요일 칸에서 시작해도 지우지 않는다
      setup('82');
      { const r=await A.buildWeekXlsx(sun), a13=rawCells(r.xml).A13||'';
        out.이름표서식={runs:(a13.match(/<r>/g)||[]).length, 빨강:/FFFF0000/.test(a13), 글:A.sheetCells({...r.tpl,sheetXml:r.xml}).A13||''};
        const base=await A.loadBaseTemplate('82'), c=A.sheetCells(base);
        let xml=base.sheetXml.replace('<mergeCell ref="A13:E13"/>','<mergeCell ref="A13:C13"/>').replace('<mergeCell ref="F13:J13"/>','<mergeCell ref="D13:J13"/>');
        xml=A.setCellStr(xml,'D13',c.F13); xml=xml.replace(/<c r="F13"([^>]*?)(?:[/]>|>[^]*?<[/]c>)/,(m,at)=>'<c r="F13"'+at.replace(/ t="[^"]*"/,'')+'/>');
        const t2={...base,sheetXml:xml}, c2=A.sheetCells(t2), m2=A.sheetMerges(t2), L=A.layoutOf({kind:'82'},c2,m2);
        const f82=A.sheetCells({...t2,sheetXml:A.fillForm82(t2,L,A.weekData(sun))}), am=A.autoMap(t2);
        out.인계사항={채움:(f82.D13||'').slice(0,6), 맵핑:(A.sheetCells({...t2,sheetXml:am.xml}).D13||'').slice(0,6), 목록:/간호부 교육/.test(f82.A13||'')}; }
      // ⑧ 일정이 많은 주는 두 개씩 한 줄 — 높이가 고정된 칸에서 잘리지 않게
      { A.store.evRules=[{id:'w',text:'주중 교육',from:'2026-09-01',to:'2026-09-30',wds:[1,2,3,4,5]},{id:'s',text:'일요 행사',from:'2026-09-06',to:'2026-09-06'}];
        const ls=A.eventListLines(A.weekData(sun)); out.일정줄={줄:ls.length, 다있음:ls.join(' ').split('(').length-1}; }
      // ⑨ 수식 칸을 채우면 calcChain 을 뺀다 — 남기면 엑셀이 '복구'를 묻는다
      { const base=await A.loadBaseTemplate('101'), enc=new TextEncoder();
        const ctE=base.ents.find(e=>e.name==='[Content_Types].xml'), relE=base.ents.find(e=>e.name==='xl/_rels/workbook.xml.rels');
        const rd=async e=>{ const b=e.meth===8?new Uint8Array(await new Response(new Blob([e.raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer()):e.raw; return new TextDecoder().decode(b); };
        const ct=(await rd(ctE)).replace('</Types>','<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/></Types>');
        const rel=(await rd(relE)).replace('</Relationships>','<Relationship Id="rIdCalc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>');
        const cc=enc.encode('<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><c r="F3" i="1"/></calcChain>');
        const withCalc={...base,ents:[...base.ents,{name:'xl/calcChain.xml',meth:0,crc:0,usz:cc.length,raw:cc}]};
        const t1=await A.parseXlsx(A.packXlsx(withCalc,{'[Content_Types].xml':ct,'xl/_rels/workbook.xml.rels':rel}));
        const t2=await A.parseXlsx(A.packXlsx(t1,{'xl/worksheets/sheet1.xml':t1.sheetXml}));
        const names=t=>t.ents.map(e=>e.name);
        out.calc={처음:names(t1).includes('xl/calcChain.xml'), 뒤:names(t2).includes('xl/calcChain.xml'),
          종류:/calcChain/.test(await rd(t2.ents.find(e=>e.name==='[Content_Types].xml'))), 관계:/calcChain/.test(await rd(t2.ents.find(e=>e.name==='xl/_rels/workbook.xml.rels')))}; }
      // ⑩ 122 는 자리표시자 양식이어도 화면 인쇄 (방 세 열을 그리는 길은 화면 인쇄뿐), 101 자리표시자 양식은 엑셀
      setup('122');
      { A.store.forms['122']={name:'옛 표시자.xlsx',b64:b64Of('122'),savedAt:9,ph:true}; A.setFormId('122'); out.인쇄122=A.canPrint();
        delete A.store.forms['122']; setup('101'); A.store.forms['101']={name:'표시자.xlsx',b64:b64Of('101'),savedAt:9,ph:true}; out.인쇄101=A.canPrint(); delete A.store.forms['101']; }
      // ⑪ 못 박은 표시자와 못 박지 않은 표시자를 섞은 양식 — 화면 자리 수가 종이와 같다
      setup('101');
      { const base=await A.loadBaseTemplate('101'), am=A.autoMap(base), m=A.sheetMerges(base);
        const mixed=am.xml.replace(/[{][{](이름|방):[DEN][.](A|B|C|D|E)[}][}]/g,(x,k)=>'{{'+k+'}}');
        const c1=A.sheetCells({...base,sheetXml:am.xml}), c2=A.sheetCells({...base,sheetXml:mixed});
        out.자리수={못박음:A.tagRows(c1,A.layoutOf({kind:'101'},c1,m)), 섞음:A.tagRows(c2,A.layoutOf({kind:'101'},c2,m)), 줄모름:A.tagRows(c2)};
        // ⑫ 표시자가 없는 요일 칸(지난주 방)은 비운다
        const t3={...base,sheetXml:A.setCellStr(am.xml.replace(/<c r="D5"([^>]*?)(?:[/]>|>[^]*?<[/]c>)/,(x,at)=>'<c r="D5"'+at.replace(/ t="[^"]*"/,'')+'/>'),'F5','12,14 (지난주)')};
        const c3=A.sheetCells(t3), x3=A.fillByPlaceholders(t3,c3,A.layoutOf({kind:'101'},c3,m),A.weekData(sun),{dateXf:await A.dateStyleSet(base)});
        const f3=A.sheetCells({...t3,sheetXml:x3}); out.지난주={F5:f3.F5||'', E5:f3.E5||''}; }
      // ⑬ 82·102 모양 병동 양식의 자리 이름은 그 모양의 내장 서식 이름
      { A.store.forms['56']={name:'56.xlsx',b64:b64Of('102'),savedAt:9,kind:'102'}; A.store.forms['57']={name:'57.xlsx',b64:b64Of('82'),savedAt:9,kind:'82'};
        const f=id=>JSON.stringify([A.formDefOf(id).labels,A.formDefOf(id).labelsN]);
        out.자리이름=[f('56')===f('102'), f('57')===f('82')]; delete A.store.forms['56']; delete A.store.forms['57']; }
      return out; })()`);
  eq('101 날짜 줄이 빈 양식 — 요일 칸을 덮지 않고 이레 모두 채운다 (내장 채우기와 같다)', rv27.빈날짜줄, []);
  eq("102 '대체' 줄 — 양식 자리 밖 사람이 대체 줄에 (내장 채우기와 같다)", [rv27.대체줄.subRow, rv27.대체줄.diff, rv27.대체줄.D9], [9, [], '정디']);
  eq('날짜 예시의 요일은 날마다, 두 자리 연도는 연도로', rv27.날짜모양, ['M/D(aaa)', 'YY.MM.DD', 'YYYY.MM.DD (aaa)', 'M월 D일 aaaa']);
  eq('날짜 글자 — 요일·두 자리 연도', rv27.날짜글자, ['9/7(월)', '26.09.07', '9월 7일 월요일']);
  ok('방 칸 양식의 SU 자리는 SU 이름 칸으로 (병동 자리·방으로 꽂지 않는다)',
    rv27.SU.kind === '82' && /[{][{]이름:D[.]SU[}][}]/.test(rv27.SU.row9) && !/[{][{]방/.test(rv27.SU.row9), JSON.stringify(rv27.SU));
  eq('문구 고치기 — A1 만 고치면 A1 만 바뀐다 (여러 줄 칸의 조각 서식이 남는다)', rv27.문구고침, ['A1']);
  eq('병동을 바꾸면 양식 검사 결과가 사라진다', rv27.검사결과, {had: true, after: false, 글: false});
  ok('82 이름표 상자의 빨간 제목 서식이 남는다', rv27.이름표서식.runs >= 2 && rv27.이름표서식.빨강 && /간호부 교육/.test(rv27.이름표서식.글), JSON.stringify(rv27.이름표서식));
  eq('인계사항 상자가 첫 요일 칸에서 시작해도 지우지 않는다', rv27.인계사항, {채움: '<인계사항>', 맵핑: '<인계사항>', 목록: true});
  eq('일정 여섯 날은 세 줄로 (두 개씩)', rv27.일정줄, {줄: 3, 다있음: 6});
  eq('시트를 고쳐 싸면 calcChain 이 빠진다 (종류·관계 목록에서도)', rv27.calc, {처음: true, 뒤: false, 종류: false, 관계: false});
  eq('122 자리표시자 양식은 화면 인쇄, 101 자리표시자 양식은 엑셀', [rv27.인쇄122, rv27.인쇄101], [true, false]);
  eq('못 박은 표시자·못 박지 않은 표시자를 섞어도 화면 자리 수가 같다', [rv27.자리수.섞음, rv27.자리수.줄모름], [rv27.자리수.못박음, null]);
  ok('못 박은 표시자로 센 자리 수', rv27.자리수.못박음 && rv27.자리수.못박음.D >= 4, JSON.stringify(rv27.자리수));
  eq('표시자가 없는 요일 칸의 지난주 값은 비운다', [rv27.지난주.F5, rv27.지난주.E5], ['', '김차지']);
  eq('82·102 모양 병동 양식의 자리 이름 = 그 모양의 내장 서식', rv27.자리이름, [true, true]);

  // ── 27e. 화면 흐름 검토 (① 네 번째 갈래, 2026-09-28) ────────────────────────────
  // 양식 검사·보기·글자 고치기는 자동 맵핑으로 '어디를 채우는지' 보이는데 올린 102·82 모양은 fillForm102 로 내보내 셋이 어긋났다.
  step('27e 양식 화면 흐름 회귀');
  const rv27e = await ev(`const A=window.__app; ${setupWeek}
    const b64Of=id=>document.querySelector(id==='101'?'#tplB64':'#tplB64_'+id).textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
    const sun=new Date(2026,8,6);
    return (async()=>{ const out={};
      // ① 82 양식의 SU 자리 이름을 병동 자리로 바꾼 파일 → 102 모양(글자 날짜·중간번 자리·인계사항 상자) 병동 양식으로 올린다
      setup('101');
      { const t82=await A.parseXlsx(A.b64ToBytes(b64Of('82')));
        let x=t82.sheetXml; x=A.setCellStr(x,'B6','C'); x=A.setCellStr(x,'B10','C'); x=A.setCellStr(x,'B12','B');
        const bytes=A.packXlsx(t82,{'xl/worksheets/sheet1.xml':x});
        const s=A.store; s.ward='81'; s.wardPicked=true; s.formId='101'; s.forms={}; A.store=s; A.recompute();
        A.show('admin'); A.pickAdmin('form');
        await A.checkFormFile({files:[new File([bytes],'81병동.xlsx')],value:''});
        A.useCheckedForm();
        const r=await A.buildWeekXlsx(sun), c=A.sheetCells({...r.tpl,sheetXml:r.xml});
        out.병동102={id:A.store.formId, kind:(A.store.forms['81']||{}).kind, D3:c.D3||'', 인계:String(c.F13||'').slice(0,6), 중간번:[c.D7||'',c.E7||'',c.F7||''],
          일정:/간호부 교육/.test(c.A13||'')};
        // 양식 보기의 '채우는 칸' 표시와 내보내기가 같은 칸을 쓴다 — 바뀐 칸은 모두 색칠돼 있다
        const t0=await A.loadTemplate(), marks=A.formMapRoles(t0,A.formDef()).marks, base=A.sheetCells(t0);
        out.표시밖=Object.keys(c).concat(Object.keys(base)).filter((k,i,a)=>a.indexOf(k)===i).filter(k=>(c[k]||'')!==(base[k]||'')&&!marks[k]); }
      // ② 모양이 다른 파일을 내장 서식 자리에 쓰지 않는다 (101 서식에 102 모양 파일)
      setup('101');
      { A.store.forms={}; A.show('admin'); A.pickAdmin('form');
        await A.checkFormFile({files:[new File([A.b64ToBytes(b64Of('102'))],'102.xlsx')],value:''});
        const before=JSON.stringify(A.store.forms);
        A.useCheckedForm();
        const toast=[...document.querySelectorAll('.toast,#toast')].map(t=>t.textContent).join(' ');
        out.모양다름={저장:JSON.stringify(A.store.forms)!==before, 알림:/쓸 수 없습니다/.test(toast)}; }
      // ③ 102 '물품체크' 를 '대체 …' 로 고치면 구조(대체 줄)가 달라진다 — 글자 고치기가 저장하지 않고, 대체 줄 이름표는 잠근다
      setup('102');
      { const base=await A.loadBaseTemplate('102'), c=A.sheetCells(base), m=A.sheetMerges(base), F=A.formDefOf('102');
        const L0=A.layoutOf(F,c,m), x2=A.setCellStr(base.sheetXml,'A18','대체 물품체크'), c2=A.sheetCells({...base,sheetXml:x2});
        out.대체줄=A.formVerdict(L0,A.layoutOf(F,c2,m));
        const t9={...base,sheetXml:A.setCellStr(base.sheetXml,'A9','대체')};
        out.대체잠금=A.formCellRoles(t9,F).locked.has('A9'); }
      // 뒤 절에 남기지 않는다 — 올린 양식·병동을 치운다
      A.store.forms={}; A.store.ward='101'; A.store.formId='101'; A.recompute();
      return out; })()`);
  eq('올린 102 모양 병동 양식 — 글자 날짜·인계사항 그대로·중간번 줄에 중간번·일정은 이름표 상자에',
    rv27e.병동102, {id: '81', kind: '102', D3: '9월 6일', 인계: '<인계사항>', 중간번: ['중간이', '', '중간이'], 일정: true});
  eq('올린 양식 — 내보내기가 바꾸는 칸은 모두 양식 보기에 색칠돼 있다', rv27e.표시밖, []);
  eq('모양이 다른 파일은 내장 서식 자리에 저장하지 않고 이유를 알린다', rv27e.모양다름, {저장: false, 알림: true});
  eq("글자 고치기로 '대체' 줄이 생기면 구조가 달라진다고 본다", rv27e.대체줄, ['대체 줄']);
  ok("'대체' 줄 이름표는 잠근다", rv27e.대체잠금 === true, String(rv27e.대체잠금));

  // ── 28. 양식 보기 (엑셀 화면 + 칸 색 + 이번 주로 채워 보기) ─────────────────────
  // 양식을 앱 안에 그리고 앱이 채우는 칸에 색을 칠한다. 색칠한 칸과 실제로 채워지는 칸이 어긋나면 화면이 거짓말을 한다 —
  // 내장 네 서식에서 '채우면 바뀌는 칸 ⊆ 색칠한 칸'을 칸마다 확인한다 (M11 ②, 2026-09-28).
  step('28 양식 보기');
  const fv = await ev(`const A=window.__app; ${setupWeek}
    const sun=new Date(2026,8,6);
    return (async()=>{ const out={};
      for(const id of ['101','102','82','122']){ setup(id);
        const tpl=await A.loadBaseTemplate(id), F=A.formDefOf(id), days=A.weekData(sun);
        const roles=A.formMapRoles(tpl,F), x1=await A.fillWeekXml(tpl,F,days,false);
        const a=A.sheetCells(tpl), b=A.sheetCells({...tpl,sheetXml:x1});
        const changed=[...new Set([...Object.keys(a),...Object.keys(b)])].filter(k=>(a[k]||'')!==(b[k]||''));
        const cnt={}; for(const r in roles.marks){ const c=roles.marks[r].cls; cnt[c]=(cnt[c]||0)+1; }
        const bw=await A.buildWeekXlsx(sun);
        const M=A.xlsxSheetModel(tpl.sheetXml,tpl.sst,await A.xlsxBook(tpl)), h=A.xlsxSheetHtml(M,await A.xlsxBook(tpl),{marks:roles.marks,imgs:await A.xlsxSheetImages(tpl),grid:true});
        out[id]={ok:roles.ok, missing:roles.missing, cnt, 안칠함:changed.filter(k=>!roles.marks[k]), 바뀜:changed.length,
          같은파일:bw.xml===x1, 크기:[M.maxR>10,M.maxC>6,h.w>500,h.h>500], 표시:(h.html.match(/<u /g)||[]).length, 칸수:Object.keys(roles.marks).length};
      }
      // 대체 줄·비우는 칸 표시
      out.대체=A.phRole('{{대체:D}}',null,A.formDefOf('102'));
      setup('101');
      { const base=await A.loadBaseTemplate('101'), am=A.autoMap(base);
        const xml=A.setCellStr(am.xml.replace(/<c r="D5"([^>]*?)(?:[/]>|>[^]*?<[/]c>)/,(x,at)=>'<c r="D5"'+at.replace(/ t="[^"]*"/,'')+'/>'),'F5','12,14 (지난주)');
        const r=A.formMapRoles({...base,sheetXml:xml},A.formDefOf('101')); out.비움=r.marks.F5&&r.marks.F5.cls; }
      // 화면 — 관리 > 배정표 양식 [양식 보기] → 이번 주로 채워 보기 → 검사한 파일 보기 → 쓰기
      setup('101'); A.show('admin'); A.pickAdmin('form');
      out.단추=!!document.querySelector('#btnFormView');
      await A.openFormView('current'); await A.renderFormView();
      const sheet=()=>document.querySelector('#fvSheet .xs'), txt=()=>(document.querySelector('#fvSheet')||{}).textContent||'';
      out.보기={화면:document.querySelector('#scrForm').style.display!=='none'&&!!sheet(), 칠함:document.querySelectorAll('#fvSheet u').length,
        탭:document.querySelector('#tabAdmin')&&document.querySelector('#tabAdmin').classList.contains('on'), 주넘기기숨김:document.querySelector('#fvWeekNav').style.display==='none'};
      A.fvSet('mode','fill'); await A.renderFormView();
      out.채움={이름:txt().includes('김차지'), 주넘기기:document.querySelector('#fvWeekNav').style.display!=='none', 글:document.querySelector('#fvWeekTitle').textContent};
      A.fvSet('week',1); await A.renderFormView(); out.다음주=document.querySelector('#fvWeekTitle').textContent;
      const b82=document.querySelector('#tplB64_82').textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
      const s=A.store; s.ward='55'; s.wardPicked=true; s.rooms=A.wardRooms('55').map(r=>[r,4]); s.forms={}; A.store=s; A.migrateStore();
      A.show('admin'); A.pickAdmin('form');
      await A.checkFormFile({files:[new File([A.b64ToBytes(b82)],'55병동.xlsx')],value:''});
      const vb=[...document.querySelectorAll('#formReport button')].find(b=>/이 양식 보기/.test(b.textContent));
      out.검사보기단추=!!vb; if(vb){ vb.click(); await new Promise(r=>setTimeout(r,50)); await A.renderFormView(); }
      out.검사={src:A.fvState.src, 제목:document.querySelector('#fvTitle').textContent, 쓰기:!![...document.querySelectorAll('#fvSide button')].find(b=>b.textContent==='이 양식 쓰기')};
      A.store.forms={}; A.setWard('101'); A.setFormId('101'); A.show('week');
      return out; })()`);
  for (const id of ['101', '102', '82', '122']) {
    const f = fv[id];
    ok(`${id} — 양식 보기가 칸을 찾았다`, f && f.ok && !f.missing.length, JSON.stringify(f && [f.ok, f.missing]));
    eq(`${id} — 채우면 바뀌는 칸은 모두 색칠돼 있다`, f && f.안칠함, []);
    ok(`${id} — 이번 주로 채워 보기는 엑셀 내보내기와 같은 파일`, f && f.같은파일 && f.바뀜 > 20, JSON.stringify(f && [f.같은파일, f.바뀜]));
    ok(`${id} — 양식을 그린다 (크기·색칠한 칸 수)`, f && f.크기.every(Boolean) && f.표시 === f.칸수, JSON.stringify(f && [f.크기, f.표시, f.칸수]));
  }
  eq('101 — 이름·방 91칸씩 (13자리 × 7일), 날짜·교육·중간번 7칸씩',
    [fv['101'].cnt.name, fv['101'].cnt.room, fv['101'].cnt.date, fv['101'].cnt.event, fv['101'].cnt.mid], [91, 91, 7, 7, 7]);
  eq('122 — 이름 98칸 (14자리 × 7일), 방 세 열 42칸', [fv['122'].cnt.name, fv['122'].cnt.room], [98, 42]);
  ok('82 — SU 칸은 다른 소속 색', fv['82'].cnt.unit >= 14, JSON.stringify(fv['82'].cnt));
  eq("'대체' 자리표시자는 이름 색 'D 대체'", [fv.대체 && fv.대체.cls, fv.대체 && fv.대체.tag], ['name', 'D 대체']);
  eq('표시자 줄에 남은 지난주 값은 비우는 칸으로 표시', fv.비움, 'clr');
  ok('관리 > 배정표 양식에 [양식 보기]', fv.단추);
  ok('양식 보기 화면 — 엑셀 모양으로 그리고 칸을 칠한다 (관리 탭 켜짐)', fv.보기.화면 && fv.보기.칠함 > 100 && fv.보기.탭 && fv.보기.주넘기기숨김, JSON.stringify(fv.보기));
  ok('이번 주로 채워 보기 — 이름이 들어가고 주를 넘긴다', fv.채움.이름 && fv.채움.주넘기기 && fv.채움.글 === '09/06 ~ 09/12' && fv.다음주 === '09/13 ~ 09/19', JSON.stringify([fv.채움, fv.다음주]));
  ok('검사한 파일을 쓰기 전에 본다', fv.검사보기단추 && fv.검사.src === 'checked' && /55병동/.test(fv.검사.제목) && fv.검사.쓰기, JSON.stringify(fv.검사));

  // ── 29. 칸 눌러 맵핑 (M11 ③) ────────────────────────────────────────────
  // 양식 보기에서 칸을 누르면 그 칸에 무엇을 채울지 고른다 — 고른 것은 칸의 자리표시자로 적고, 요일 칸은 일요일 칸을 고친다.
  step('29 칸 눌러 맵핑');
  const cm = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), sun=new Date(2026,8,6);
    const modal=()=>({on:document.querySelector('#modal').classList.contains('on'), t:(document.querySelector('#modalBox .mt')||{}).textContent||'',
      cur:[...document.querySelectorAll('#modalBox button.cur')].map(b=>b.textContent), ops:[...document.querySelectorAll('#modalBox button[data-g]')].map(b=>b.textContent)});
    const choose=async label=>{ const b=[...document.querySelectorAll('#modalBox button[data-g]')].find(x=>x.textContent===label); if(!b) return 'no '+label; b.click(); await sleep(150); return 'ok'; };
    const cancel=async()=>{ const b=document.querySelector('#mdCancel'); if(b&&document.querySelector('#modal').classList.contains('on')) b.click(); await sleep(50); };
    // 그려진 칸(맵핑 표시·글자)의 한가운데를 누른다 — 맞춤으로 줄인 종이에서도 누른 칸을 찾아야 한다
    const clickEl=async sel=>{ const el=document.querySelector(sel); if(!el) return 'no '+sel; const r=el.getBoundingClientRect();
      document.querySelector('#fvSheet .xs').dispatchEvent(new MouseEvent('click',{clientX:r.left+r.width/2,clientY:r.top+r.height/2,bubbles:true})); await sleep(150); return 'ok'; };
    const cellsOf=x=>A.sheetCells({sheetXml:x,sst:[]});
    return (async()=>{ const out={};
      setup('101'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form');
      await A.openFormView('current'); await A.renderFormView();
      out.편집=document.querySelector('#fvSheet .xs').classList.contains('edit');
      // 화요일 D 둘째 줄 방(H6) → 일요일 칸 D6 을 고친다
      out.누름=await clickEl('#fvSheet u[data-ref="H6"]'); out.창=modal();
      out.고름=await choose('C 방');
      out.초안={D6:cellsOf(A.fvDraft.xml).D6, n:A.fvChangedCount(), 고침:A.fvDirty(), 겹침:/D6·D7/.test(document.querySelector('#fvSide').textContent)};
      { const tpl=await A.loadTemplate(), c=A.sheetCells({...tpl,sheetXml:await A.fillWeekXml({...tpl,sheetXml:A.fvDraft.xml},A.formDef(),A.weekData(sun),true)});
        out.채워보기=[c.D6===c.D7, !!c.D6, c.H6===c.H7]; }
      out.저장전내보내기=(A.sheetCells((r=>({...r.tpl,sheetXml:r.xml}))(await A.buildWeekXlsx(sun))).D6||'')!==(A.sheetCells((r=>({...r.tpl,sheetXml:r.xml}))(await A.buildWeekXlsx(sun))).D7||'');
      out.되돌림=[A.fvUndoCell(), A.fvDirty()];
      // 구조를 읽는 칸(요일)은 맵핑하지 않는다
      out.요일칸=[await clickEl('#fvSheet b[data-ref="H2"]'), modal().on, (document.querySelector('#toast')||{}).textContent||'']; await cancel();
      // 중간번 줄을 비우고 저장 → 자리표시자 양식, 엑셀로 인쇄
      await clickEl('#fvSheet u[data-ref="J10"]'); out.중간번창=modal(); out.비움=await choose('앱이 채우지 않음');
      // 저장 안 하고 떠나려 하면 묻는다 (취소하면 남는다)
      window.confirm=()=>false; A.show('week'); out.남음=A.fvState&&document.querySelector('#scrForm').style.display!=='none';
      window.confirm=()=>true;
      await A.fvSave(); await sleep(200);
      const ov=A.store.forms['101'];
      const x=(r=>A.sheetCells({...r.tpl,sheetXml:r.xml}))(await A.buildWeekXlsx(sun));
      out.저장={ph:ov&&ov.ph, 이름:ov&&/[(]맵핑[)]$/.test(ov.name), 인쇄:A.canPrint(), 초안:A.fvDraft, D10:x.D10||'', J10:x.J10||'', E5:x.E5, H10:x.H10||''};
      out.되돌리기=(()=>{ A.undoAny(); return !A.formOv('101'); })();
      // 떠날 때 확인하면 초안을 버린다
      await A.openFormView('current'); await A.renderFormView(); await clickEl('#fvSheet u[data-ref="D5"]'); await choose('B 이름');
      A.show('week'); out.떠남={화면:document.querySelector('#scrForm').style.display==='none', 초안:A.fvDraft};
      // 82 — 방 칸이 없는 서식은 방을 고르지 않고, SU·대체를 고를 수 있다. 이름표 칸의 조각 서식은 표시자만 바꾼다
      setup('82'); A.wkSunday=new Date(sun); await A.openFormView('current'); await A.renderFormView();
      await clickEl('#fvSheet u[data-ref="E4"]'); const m82=modal(); await cancel();
      out.m82={t:m82.t, 방:m82.ops.some(o=>/ 방$/.test(o)), SU:m82.ops.includes('SU 이름'), 대체:m82.ops.includes('대체'), 새자리:m82.ops.filter(o=>/새 자리/.test(o)).length};
      { const base=await A.loadBaseTemplate('82'), am=A.autoMap(base), t={...base,sheetXml:am.xml};
        const raw=x=>{ const m=x.match(/<c r="A13"[^>]*?(?:[/]>|>[^]*?<[/]c>)/); return m?m[0]:''; };
        const x1=A.setCellTag(am.xml,t,'A13','{{교육}}',false), x2=A.setCellTag(am.xml,t,'A13','',false);
        out.조각={바꿈:/FFFF0000/.test(raw(x1))&&cellsOf(x1).A13.split(String.fromCharCode(10)).pop(), 지움:/FFFF0000/.test(raw(x2))&&!/[{][{]/.test(cellsOf(x2).A13), 이름표:cellsOf(x2).A13.trim()}; }
      // 122 · 검사한 파일은 고치지 않는다 (이유를 알린다)
      setup('122'); await A.openFormView('current'); await A.renderFormView();
      out.m122={편집:document.querySelector('#fvSheet .xs').classList.contains('edit'), 안내:/122 모양/.test(document.querySelector('#fvSide').textContent)};
      out.m122.창=[await clickEl('#fvSheet u[data-ref="D5"]'), modal().on];
      A.store.forms={}; setup('101'); A.show('week');
      return out; })()`);
  ok('양식 보기의 종이를 누를 수 있다', cm.편집);
  eq('화요일 칸을 눌러도 일요일 칸을 고친다 (지금 것에 표시)', [cm.누름, cm.창.t, cm.창.cur], ['ok', 'D6 칸에 무엇을 채울까요?', ['B 방']]);
  eq('고른 것이 칸의 자리표시자가 된다 · 같은 자리 두 칸은 알린다', [cm.고름, cm.초안], ['ok', {D6: '{{방:D.B}}', n: 1, 고침: true, 겹침: true}]);
  eq('채워 보기는 저장 전 맵핑으로 (이레 모두)', cm.채워보기, [true, true, true]);
  eq('저장 전엔 내보내기가 그대로', cm.저장전내보내기, true);
  eq('한 칸 되돌리기', cm.되돌림, [true, false]);
  ok('요일 칸은 맵핑하지 않는다 (이유를 알린다)', cm.요일칸[0] === 'ok' && cm.요일칸[1] === false && /D2 칸은 요일/.test(cm.요일칸[2]), JSON.stringify(cm.요일칸));
  eq('중간번 칸', [cm.중간번창.t, cm.중간번창.cur, cm.비움], ['D10 칸에 무엇을 채울까요?', ['중간번'], 'ok']);
  eq('저장 안 한 채 떠나려 하면 묻고, 취소하면 남는다', cm.남음, true);
  eq('저장하면 자리표시자 양식 (101 은 엑셀로 인쇄) · 비운 칸은 채우지 않는다',
    cm.저장, {ph: true, 이름: true, 인쇄: false, 초안: null, D10: '', J10: '', E5: '김차지', H10: ''});
  eq('저장은 되돌리기 한 번으로 돌아온다', cm.되돌리기, true);
  eq('떠나겠다고 하면 초안을 버린다', cm.떠남, {화면: true, 초안: null});
  eq('82 — 방 없는 서식은 방을 고르지 않고 SU·대체·새 자리 하나씩',
    cm.m82, {t: 'D4 칸에 무엇을 채울까요?', 방: false, SU: true, 대체: true, 새자리: 3});
  eq('이름표 칸 — 조각 서식(빨간 제목)을 두고 표시자만 바꾸거나 지운다', cm.조각, {바꿈: '{{교육}}', 지움: true, 이름표: '<교육 및 행사 일정>'});
  eq('122 모양은 칸 맵핑을 고치지 않고 이유를 보인다', cm.m122, {편집: false, 안내: true, 창: ['ok', false]});

  // ── 29b. 칸 눌러 맵핑 — 교차 검토에서 재현된 것 (2026-09-28) ────────────────────────
  // 표 아래 상자(H20:K20)를 누르면 가려진 일요일 칸(D20)을 고친다고 하고 칸 글자를 통째로 바꿨다 · 82 인계사항(F13:J13)도 같았다 ·
  // 저장을 되돌려도 종이가 옛 양식 · 82 선택지 '대체 이름' 셋 · 82 날짜 모양이 풀림 · 교육 이름표 칸(A13)을 못 누름 ·
  // [이 양식 쓰기]가 오류 · 한 칸 되돌려도 고친 칸 수 그대로 · 투어가 떠나기 확인을 거듭 · 채워 보기의 받기 단추가 저장본인 줄 모름 ·
  // 82 에 더한 자리가 종이엔 찍히는데 화면은 안 찍힌다고 함 · 가운데 자리 이름 칸을 지우면 그 사람이 조용히 빠짐
  step('29b 칸 눌러 맵핑 — 교차 검토');
  const cr = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), sun=new Date(2026,8,6);
    const modal=()=>({on:document.querySelector('#modal').classList.contains('on'), t:(document.querySelector('#modalBox .mt')||{}).textContent||'',
      cur:[...document.querySelectorAll('#modalBox button.cur')].map(b=>b.textContent), ops:[...document.querySelectorAll('#modalBox button[data-g]')].map(b=>b.textContent),
      grp:[...document.querySelectorAll('#modalBox .mo')].map(g=>[...g.querySelectorAll('button[data-g]')].map(b=>b.textContent))});
    const choose=async label=>{ const b=[...document.querySelectorAll('#modalBox button[data-g]')].find(x=>x.textContent===label); if(!b) return 'no '+label; b.click(); await sleep(150); return 'ok'; };
    const cancel=async()=>{ const b=document.querySelector('#mdCancel'); if(b&&document.querySelector('#modal').classList.contains('on')) b.click(); await sleep(50); };
    // 칸의 왼쪽 위 가까이를 누른다 — 병합 칸은 누른 자리가 병합 안 어디든 같은 칸이다
    const clickRef=async ref=>{ const xs=document.querySelector('#fvSheet .xs'), M=A.fvCache.M, m=ref.match(/^([A-Z]+)([0-9]+)$/), c=A.colNum(m[1]), r=+m[2];
      const rc=xs.getBoundingClientRect(), k=rc.width/A.fvCache.w;
      xs.dispatchEvent(new MouseEvent('click',{clientX:rc.left+(M.X[c]+3)*k,clientY:rc.top+(M.Y[r]+3)*k,bubbles:true})); await sleep(200); };
    const toastTxt=()=>(document.querySelector('#toast')||{}).textContent||'';
    const cellsOf=x=>A.sheetCells({sheetXml:x,sst:[]});
    const warns=()=>[...document.querySelectorAll('#wkWarn *')].filter(x=>x.children.length===0).map(x=>x.textContent).filter(t=>/인쇄에 나오지/.test(t));
    return (async()=>{ const out={};
      setup('101'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form');
      await A.openFormView('current'); await A.renderFormView();
      const base=await A.loadTemplate(), baseFill=A.sheetCells({...base,sheetXml:await A.fillWeekXml(base,A.formDef(),A.weekData(sun),false)});
      // 표 아래 상자 H20:K20 — 그 칸 하나(화요일), 글자는 두고 뒤에 붙인다. 그 주 목록을 고를 수 있다
      await clickRef('I20'); out.h20=modal(); const ok20=await choose('교육·행사 (그 주 목록)');
      { const d=cellsOf(A.fvDraft.xml), f=A.sheetCells({...base,sheetXml:await A.fillWeekXml({...base,sheetXml:A.fvDraft.xml},A.formDef(),A.weekData(sun),true)});
        out.h20결과={ok:ok20, 표시자:/[{][{]교육:목록[}][}]$/.test(d.H20||''), 글자남음:(d.H20||'').startsWith(String(A.sheetCells(base).H20||'').trim()),
          D20:d.D20===undefined||d.D20===A.sheetCells(base).D20, 채움:/CPR/.test(f.H20||''), 이웃:['C20','L20','C21','H21'].every(k=>f[k]===baseFill[k])}; }
      A.fvUndoCell(); await sleep(100);
      // 표 아래 일요일 열(E26:I26) — 이레로 복제되고 줄 글자를 지우므로 막는다
      await clickRef('F26'); out.e26=[modal().on, /E26 칸은 표 아래/.test(toastTxt())]; await cancel();
      // 요일 칸 안에서는 그 주 목록을 고르지 않는다 (이레 모두에 찍힌다)
      await clickRef('H6'); out.요일칸목록=modal().ops.includes('교육·행사 (그 주 목록)'); await cancel();
      // 두 칸 고치고 한 칸 되돌리면 고친 칸 1곳
      await clickRef('H6'); await choose('C 방'); await clickRef('E7'); await choose('B 이름');
      out.칸수=[A.fvChangedCount()]; A.fvUndoCell(); await sleep(150);
      out.칸수.push(A.fvChangedCount(), /고친 칸 1곳/.test(document.querySelector('#fvSide').textContent));
      // 채워 보기 — 저장 안 한 맵핑이면 받기 단추가 저장본으로 받는다고 말한다
      A.fvSet('mode','fill'); await sleep(300);
      out.받기=[[...document.querySelectorAll('#fvSide button')].some(b=>b.textContent==='저장한 맵핑으로 엑셀 받기'), /저장한 맵핑/.test(document.querySelector('#fvSide').textContent)];
      A.fvSet('mode','map'); await sleep(300);
      // 투어 — 저장 안 한 맵핑이 있으면 한 번만 묻고, 취소하면 시작하지 않는다
      let asked=0; window.confirm=()=>{ asked++; return false; };
      out.투어=[A.startTopicTour('form'), asked, document.querySelector('#tourShield').classList.contains('on'), document.querySelector('#scrForm').style.display!=='none', A.fvDirty()];
      window.confirm=()=>true;
      // 저장 → 되돌리기: 종이도 되돌린 양식으로 다시 그린다
      await A.fvSave(); await sleep(300);
      const saved=document.querySelector('#fvSheet u[data-ref="D6"]').textContent;
      A.undoAny(); await sleep(400);
      out.되돌리기=[saved, document.querySelector('#fvSheet u[data-ref="D6"]').textContent, !!A.formOv('101')];
      // 가운데 자리(B) 이름 칸을 지우면 옆 상자와 배정표 화면이 알린다
      await clickRef('E6'); await choose('앱이 채우지 않음');
      out.빈자리=[...document.querySelectorAll('#fvSide .fvList.miss li')].map(x=>x.textContent);
      await A.fvSave(); await sleep(300); A.show('week'); await sleep(600);
      out.빈자리화면=warns().filter(t=>/이름 칸이 없어/.test(t)).length;
      A.undoAny(); await sleep(200);
      // 82 — 자리 선택지는 겹치지 않고 새 자리는 하나, 날짜는 양식 모양 그대로, 인계사항·교육 이름표 칸
      setup('82'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form'); await A.openFormView('current'); await A.renderFormView();
      await clickRef('D5'); { const m=modal(); out.m82=m.grp.slice(1,4).map(g=>({같은이름:g.length!==new Set(g).size, 새자리:g.filter(o=>/새 자리/.test(o))})); } await cancel();
      await clickRef('G3'); out.날짜=modal().cur; await choose(out.날짜[0]||'x'); out.날짜.push(A.fvDirty());
      await clickRef('H13'); out.인계=[modal().t, modal().ops.includes('교육·행사 (그 주 목록)')]; await cancel();
      await clickRef('B13'); out.교육칸=[modal().t, modal().cur]; await cancel();
      // 82 에 자리를 하나 더한다(D7 = B) — 저장하면 배정표 화면도 그 자리를 종이에 찍히는 자리로 센다
      A.show('week'); await sleep(400); const before=warns().join(' ');
      A.show('admin'); A.pickAdmin('form'); await A.openFormView('current'); await A.renderFormView();
      await clickRef('D7'); const nw=modal().ops.find(o=>/새 자리/.test(o)); await choose(nw);
      await A.fvSave(); await sleep(300); await A.loadTemplate(); A.recompute(); A.show('week'); await sleep(600);
      out.m82자리={자리:A.slotsOf('D').join(','), 전:/박비/.test(before), 후:/박비/.test(warns().join(' '))};
      // 검사한 파일 보기 — [이 양식 쓰기]를 누르면 오류 없이 지금 서식 보기로 넘어가 칸을 고칠 수 있다
      A.store.forms={}; setup('101');
      const s=A.store; s.ward='55'; s.wardPicked=true; s.rooms=A.wardRooms('55').map(r=>[r,4]); A.store=s; A.migrateStore();
      A.show('admin'); A.pickAdmin('form');
      const b82=document.querySelector('#tplB64_82').textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
      await A.checkFormFile({files:[new File([A.b64ToBytes(b82)],'55병동.xlsx')],value:''});
      await A.openFormView('checked'); await A.renderFormView();
      const e0=(window.__pageErrors||[]).length;
      [...document.querySelectorAll('#fvSide button')].find(b=>b.textContent==='이 양식 쓰기').click(); await sleep(600);
      out.쓰기={오류:(window.__pageErrors||[]).length-e0, src:A.fvState.src, 편집:!!document.querySelector('#fvSheet .xs.edit'), 저장:!!(A.store.forms||{})['55']};
      A.store.forms={}; A.setWard('101'); A.setFormId('101'); setup('101'); A.show('week');
      return out; })()`, 60000);
  eq('표 아래 상자는 그 칸 하나만 — 가린 칸(D20)을 고치지 않고 칸 글자와 이웃 칸을 지킨다',
    [cr.h20.t, cr.h20결과], ['H20 칸에 무엇을 채울까요?', {ok: 'ok', 표시자: true, 글자남음: true, D20: true, 채움: true, 이웃: true}]);
  eq('표 아래 일요일 열 칸은 막는다 (이유를 알린다)', cr.e26, [false, true]);
  eq('요일 칸에는 그 주 목록을 고르지 않는다', cr.요일칸목록, false);
  eq('한 칸 되돌리면 고친 칸 수도 줄어든다', cr.칸수, [2, 1, true]);
  eq('채워 보기 — 저장 안 한 맵핑이면 받기 단추가 저장본으로 받는다고 말한다', cr.받기, [true, true]);
  eq('투어 — 저장 안 한 맵핑이 있으면 한 번만 묻고 취소하면 시작하지 않는다', cr.투어, [false, 1, false, true, true]);
  eq('맵핑 저장을 되돌리면 종이도 되돌린다', cr.되돌리기, ['D C 방', 'D B 방', false]);
  ok('가운데 자리 이름 칸을 지우면 옆 상자와 배정표 화면이 알린다',
    cr.빈자리.some(t => /D B 자리 이름 칸이 없습니다/.test(t)) && cr.빈자리화면 > 0, JSON.stringify([cr.빈자리, cr.빈자리화면]));
  eq('82 — 자리 선택지 이름이 겹치지 않고 새 자리는 근무마다 하나', cr.m82,
    [{같은이름: false, 새자리: ['대체 이름 (새 자리)']}, {같은이름: false, 새자리: ['대체 이름 (새 자리)']}, {같은이름: false, 새자리: ['대체 이름 (새 자리)']}]);
  eq('82 날짜 — 양식 모양이 지금 것으로 표시되고 골라도 바뀌지 않는다', cr.날짜, ['날짜 (M월 D일)', false]);
  eq('82 인계사항 상자 — 가린 칸이 아니라 그 칸(F13), 그 주 목록을 고를 수 있다', cr.인계, ['F13 칸에 무엇을 채울까요?', true]);
  eq('82 교육 이름표 칸(A13)은 표시자만 바꾼다', cr.교육칸, ['A13 칸에 무엇을 채울까요?', ['교육·행사 (그 주 목록)']]);
  eq('82 에 더한 자리 — 배정표 화면도 종이에 찍히는 자리로 센다', cr.m82자리, {자리: '차지,A,B,SU,중간번', 전: true, 후: false});
  eq('검사한 파일의 [이 양식 쓰기] — 오류 없이 지금 서식 보기로, 칸을 고칠 수 있다', cr.쓰기, {오류: 0, src: 'current', 편집: true, 저장: true});
  // 저장 둘레 — 되돌리기 알림·옛 검사 결과·이름 꼬리. 따로 돌린다(하나가 멈춰도 나머지를 본다)
  step('29c 맵핑 저장 둘레 — 저장 알림 되돌리기');
  const cs1 = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const choose=async label=>{ const b=[...document.querySelectorAll('#modalBox button[data-g]')].find(x=>x.textContent===label); if(!b) return 'no '+label; b.click(); await sleep(150); return 'ok'; };
    const clickRef=async ref=>{ const xs=document.querySelector('#fvSheet .xs'), M=A.fvCache.M, m=ref.match(/^([A-Z]+)([0-9]+)$/), c=A.colNum(m[1]), r=+m[2];
      const rc=xs.getBoundingClientRect(), k=rc.width/A.fvCache.w;
      xs.dispatchEvent(new MouseEvent('click',{clientX:rc.left+(M.X[c]+3)*k,clientY:rc.top+(M.Y[r]+3)*k,bubbles:true})); await sleep(200); };
    const reset=()=>{ window.confirm=()=>true; A.fvDiscard(); A.store.forms={}; A.setWard('101'); A.setFormId('101'); setup('101'); A.show('week'); };
    return (async()=>{ reset(); A.show('admin'); A.pickAdmin('form');
      await A.openFormView('current'); await A.renderFormView();
      await clickRef('D6'); await choose('C 방'); await A.fvSave(); await sleep(300);
      await clickRef('D7'); await choose('D 방');
      let asked=0; window.confirm=()=>{ asked++; return false; };
      document.querySelector('#toast').click(); await sleep(200);
      const r=[asked, !!A.formOv('101'), A.fvDirty()]; reset(); return r; })()`, 30000);
  eq('저장 알림을 눌러 되돌릴 때 새로 고친 칸이 있으면 묻고, 취소하면 그대로', cs1, [1, true, true]);
  step('29c 맵핑 저장 둘레 — 옛 양식 파일 검사 결과');
  // 검사한 파일(바이트)을 통째로 돌려받으면 하네스가 멈춘다 — 있는지만 본다
  const cs2 = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const choose=async label=>{ const b=[...document.querySelectorAll('#modalBox button[data-g]')].find(x=>x.textContent===label); if(!b) return 'no '+label; b.click(); await sleep(150); return 'ok'; };
    const clickRef=async ref=>{ const xs=document.querySelector('#fvSheet .xs'), M=A.fvCache.M, m=ref.match(/^([A-Z]+)([0-9]+)$/), c=A.colNum(m[1]), r=+m[2];
      const rc=xs.getBoundingClientRect(), k=rc.width/A.fvCache.w;
      xs.dispatchEvent(new MouseEvent('click',{clientX:rc.left+(M.X[c]+3)*k,clientY:rc.top+(M.Y[r]+3)*k,bubbles:true})); await sleep(200); };
    const reset=()=>{ window.confirm=()=>true; A.fvDiscard(); A.store.forms={}; A.setWard('101'); A.setFormId('101'); setup('101'); A.show('week'); };
    return (async()=>{ reset(); A.show('admin'); A.pickAdmin('form');
      const b101=document.querySelector('#tplB64').textContent.replace(/[/][*][^*]*[*][/]/g,'').trim();
      await A.checkFormFile({files:[new File([A.b64ToBytes(b101)],'사본.xlsx')],value:''});
      const had=!!window.__formReportHtml;
      await A.openFormView('current'); await A.renderFormView(); await clickRef('D6'); await choose('C 방'); await A.fvSave(); await sleep(300);
      A.show('admin'); await sleep(200);
      const r=[had, !!window.__formReportHtml, !!window.__checkedForm, (document.querySelector('#formReport')||{}).textContent||'']; reset(); return r; })()`, 30000);
  eq('양식을 저장하면 전의 양식 파일 검사 결과를 지운다', cs2, [true, false, false, '']);
  step('29c 맵핑 저장 둘레 — 양식 이름 꼬리');
  const cs3 = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const choose=async label=>{ const b=[...document.querySelectorAll('#modalBox button[data-g]')].find(x=>x.textContent===label); if(!b) return 'no '+label; b.click(); await sleep(150); return 'ok'; };
    const clickRef=async ref=>{ const xs=document.querySelector('#fvSheet .xs'), M=A.fvCache.M, m=ref.match(/^([A-Z]+)([0-9]+)$/), c=A.colNum(m[1]), r=+m[2];
      const rc=xs.getBoundingClientRect(), k=rc.width/A.fvCache.w;
      xs.dispatchEvent(new MouseEvent('click',{clientX:rc.left+(M.X[c]+3)*k,clientY:rc.top+(M.Y[r]+3)*k,bubbles:true})); await sleep(200); };
    const reset=()=>{ window.confirm=()=>true; A.fvDiscard(); A.store.forms={}; A.setWard('101'); A.setFormId('101'); setup('101'); A.show('week'); };
    return (async()=>{ reset(); A.show('admin'); A.pickAdmin('form');
      await A.openFormView('current'); await A.renderFormView(); await clickRef('D6'); await choose('C 방'); await A.fvSave(); await sleep(300);
      A.show('admin'); await A.openFormText();
      [...document.querySelectorAll('#formText textarea')].find(t=>t.dataset.ref==='A1').value='업무분담 (고침)'; await A.saveFormText();
      const n1=A.formOv('101').name;
      await A.openFormView('current'); await A.renderFormView(); await clickRef('D7'); await choose('D 방'); await A.fvSave(); await sleep(300);
      const r=[n1, A.formOv('101').name]; reset(); return r; })()`, 30000);
  eq('양식 이름 꼬리는 하나만 — 문구 고치기와 맵핑 저장을 번갈아 해도', cs3, ['병실 배정표 (고침)', '병실 배정표 (맵핑)']);

  step('30 양식 고치기 — 칸 글자 · 자리 줄 넣기·빼기 (M11 ④)');
  const ed = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), sun=new Date(2026,8,6), NL=String.fromCharCode(10);
    const modal=()=>({t:(document.querySelector('#modalBox .mt')||{}).textContent||'', 글자단추:!!document.querySelector('#mdTextBtn')});
    const clickRef=async ref=>{ const xs=document.querySelector('#fvSheet .xs'), M=A.fvCache.M, m=ref.match(/^([A-Z]+)([0-9]+)$/), c=A.colNum(m[1]), r=+m[2];
      const rc=xs.getBoundingClientRect(), k=rc.width/A.fvCache.w;
      xs.dispatchEvent(new MouseEvent('click',{clientX:rc.left+(M.X[c]+3)*k,clientY:rc.top+(M.Y[r]+3)*k,bubbles:true})); await sleep(200); };
    // [✏ 글자 고치기] → 글 상자에 적고 확인 — 처음 들어 있던 글을 돌려준다
    const typeText=async t=>{ document.querySelector('#mdTextBtn').click(); await sleep(50); const i=document.querySelector('#mdInput'), v0=i.value;
      i.value=t; document.querySelector('#mdOk').click(); await sleep(250); return v0; };
    const toastTxt=()=>(document.querySelector('#toast')||{}).textContent||'';
    const rows=()=>[...document.querySelectorAll('#fvSide .fvRow')].map(x=>x.querySelector('span').textContent);
    const chg=()=>{ const m=((document.querySelector('#fvSide .fvEdit')||{}).textContent||'').match(/(고친 칸[^—]*|자리 줄 [DEN][^—]*)—/); return m?m[1].trim():''; };
    const dc=()=>A.sheetCells({sheetXml:A.fvDraft.xml,sst:A.fvDraft.sst});
    const warns=()=>[...document.querySelectorAll('#wkWarn *')].filter(x=>x.children.length===0).map(x=>x.textContent).filter(t=>/인쇄에 나오지/.test(t));
    return (async()=>{ const out={};
      setup('101'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form');
      await A.openFormView('current'); await A.renderFormView();
      out.상자=rows();
      // D +1 — 끝 줄(아래 굵은 선) 앞에 줄을 넣고 끝 줄을 새 자리 F 로. 끝 자리 표시자를 본떠 E 자리
      await A.fvRowOp('D',1); await sleep(200);
      { const c=dc(); out.넣기={상자:rows()[0], C9:c.C9, C10:c.C10, D10:c.D10, E10:c.E10, 요약:chg()}; }
      await A.fvRowOp('E',-1); await sleep(200);
      out.빼기=[rows()[1], chg(), toastTxt()];
      // 표 밖 칸 글자 — 고치고, 구조를 바꾸는 글자(중간번)는 거절
      await clickRef('C20'); out.글자창=modal(); out.글자처음=await typeText('마약, 비품약');
      out.글자=dc().C20;
      await clickRef('C20'); await typeText('중간번'); out.거절=[/양식 구조/.test(toastTxt()), dc().C20];
      out.칸수=[A.fvCellEdits(), A.fvChangedCount(), chg()];
      // 하나 되돌리기 — 글자 → E −1 순서
      A.fvUndoCell(); await sleep(150); out.되1=[A.fvCellEdits(), A.fvDraft.ops.length, chg()];
      A.fvUndoCell(); await sleep(150); out.되2=[rows(), chg()];
      await A.fvRowOp('E',-1); await sleep(200);
      await clickRef('C20'); await typeText('마약, 비품약');
      let msg=''; window.confirm=m=>{ msg=m; return false; }; A.show('week'); out.떠나기=(msg.match(/고친 것[(][^)]*[)]/)||[''])[0]; window.confirm=()=>true;
      await A.fvSave(); await sleep(400);
      out.저장=[/칸 1곳 · 자리 줄 D [+]1 · E −1을/.test(toastTxt()), !!(A.store.forms['101']||{}).ph];
      await A.loadTemplate(); A.recompute();
      out.자리=[A.secRows('D'), A.secRows('E'), A.slotsOf('D').join(','), A.FORM_LBL('E','D'), A.canPrint()];
      const r=await A.buildWeekXlsx(sun), x=A.sheetCells({...r.tpl,sheetXml:r.xml});
      out.내보내기={C10:x.C10, E10:x.E10, C15:x.C15, E15:x.E15, C16:x.C16, C20:x.C20};
      A.show('week'); await sleep(600);
      out.화면=[warns().filter(t=>/배디/.test(t)).length>0, [...document.querySelectorAll('#wkTable td.lab')].map(td=>td.textContent).slice(0,13).join(' ')];
      A.undoAny(); await sleep(300); out.되돌림=[!!(A.store.forms||{})['101'], A.secRows('D'), A.secRows('E')];
      // 102 — 넣은 자리 이름은 종이 글자(E), 그림은 한 줄 아래로(보기·파일 모두)
      A.store.forms={}; setup('102'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form'); await A.openFormView('current'); await A.renderFormView();
      const t0=await A.loadTemplate(), im0=(await A.xlsxSheetImages(t0)).map(i=>i.fr);
      await A.fvRowOp('D',1); await sleep(200);
      const imV=A.fvImgShift(await A.xlsxSheetImages(t0),A.fvDraft.ops).map(i=>i.fr);
      await A.fvSave(); await sleep(400);
      const t1=await A.loadTemplate(); A.recompute();
      { const r2=await A.buildWeekXlsx(sun), y=A.sheetCells({...r2.tpl,sheetXml:r2.xml});
        out.m102={그림:[im0,imV,(await A.xlsxSheetImages(t1)).map(i=>i.fr)], 이름:A.FORM_LBL('D','D'), 자리:A.secRows('D'), C9:y.C9, D9:y.D9, A10:y.A10, D10:y.D10}; }
      // 82 — SU·중간번 줄이 구역 안이라 자리 줄은 막고, 조각 서식 칸(인계사항)은 바뀐 부분만 바꾼다
      A.store.forms={}; setup('82'); await A.openFormView('current'); await A.renderFormView();
      out.m82=[/82 모양/.test((document.querySelector('#fvSide .fvEdit.off')||{}).textContent||''), rows().length];
      await A.fvRowOp('D',1); await sleep(100); out.m82t=[/82 모양/.test(toastTxt()), A.fvDraft?A.fvDraft.ops.length:0];
      await clickRef('H13'); const f13o=await typeText('<인계사항>'+NL+'새 글');
      const raw=(A.fvDraft.xml.match(/<c r="F13"[^>]*?(?:[/]>|>[^]*?<[/]c>)/)||[''])[0];
      out.f13={처음:f13o.slice(0,6), 조각:[...raw.matchAll(/<r>([^]*?)<[/]r>/g)].map(m=>[/FFFF0000/.test(m[1]), ((m[1].match(/<t[^>]*>([^]*?)<[/]t>/)||[])[1]||'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&')])};
      A.fvDiscard(); A.store.forms={}; setup('101'); A.show('week');
      return out; })()`, 60000);
  eq('자리 줄 상자 — 근무마다 지금 자리 수', ed.상자, ['D 근무 5자리', 'E 근무 5자리', 'N 근무 3자리']);
  eq('D 자리 줄 넣기 — 끝 줄 앞에 넣고 새 자리 F 는 끝 자리 표시자를 본뜬다', ed.넣기,
    {상자: 'D 근무 6자리', C9: 'E', C10: 'F', D10: '{{방:D.E}}', E10: '{{이름:D.E}}', 요약: '자리 줄 D +1'});
  eq('E 자리 줄 빼기', ed.빼기, ['E 근무 4자리', '자리 줄 D +1 · E −1', 'E 근무 마지막 자리 줄(E)을 뺐습니다']);
  eq('표 밖 칸은 [✏ 글자 고치기]가 있고 고친 글이 들어간다', [ed.글자창, ed.글자처음, ed.글자],
    [{t: 'C20 칸에 무엇을 채울까요?', 글자단추: true}, '마약, 비품약, E-cart, 냉장고', '마약, 비품약']);
  eq('구역 이름으로 읽히는 글자(중간번)는 거절하고 초안을 그대로 둔다', ed.거절, [true, '마약, 비품약']);
  eq('고친 곳 = 칸 + 자리 줄', ed.칸수, [1, 3, '고친 칸 1곳 · 자리 줄 D +1 · E −1']);
  eq('하나 되돌리기 — 글자 먼저, 다음은 자리 줄', [ed.되1, ed.되2],
    [[0, 2, '자리 줄 D +1 · E −1'], [['D 근무 6자리', 'E 근무 5자리', 'N 근무 3자리'], '자리 줄 D +1']]);
  eq('저장 전에 떠나면 고친 곳 수를 말하고 묻는다', ed.떠나기, '고친 것(3곳)');
  eq('저장 — 토스트에 칸·자리 줄, 자리표시자 양식', ed.저장, [true, true]);
  eq('저장 뒤 자리 — D 6 · E 4, 여섯째 자리 이름은 종이 글자 F, 101 인쇄 틀은 안 쓴다', ed.자리, [6, 4, '차지,A,B,C,D,E', 'F', false]);
  eq('엑셀 내보내기 — 새 D 자리에 여섯째 사람, E 는 네 줄, 표 아래 글자도 고친 대로', ed.내보내기,
    {C10: 'F', E10: '한이', C15: 'D', E15: '장씨', C16: 'A(CN)', C20: '마약, 비품약'});
  eq('배정표 화면 — 뺀 E 자리 사람은 인쇄에 안 나온다고 알리고 자리 이름은 종이대로', ed.화면,
    [true, 'A(CN) B C D E F A(CN) B C D A(CN) B C']);
  eq('저장을 되돌리면 자리 수도 돌아온다', ed.되돌림, [false, 5, 5]);
  eq('102 D 자리 넣기 — 새 자리 이름 E, 그림은 보기·파일 모두 한 줄 아래, 중간번 줄은 그대로 채운다', ed.m102,
    {그림: [[23], [24], [24]], 이름: 'E', 자리: 5, C9: 'E', D9: '정디', A10: '중간번', D10: '중간이'});
  eq('82 — 자리 줄은 이유를 말하고 막는다', [ed.m82, ed.m82t], [[true, 0], [true, 0]]);
  eq('82 인계사항(조각 서식) — 빨간 머리글은 그대로, 바뀐 본문만 본문 서식으로', ed.f13,
    {처음: '<인계사항>', 조각: [[true, '<인계사항>'], [false, '\n새 글']]});

  step('30b 자리 줄 — 선·병합·자리 이름 열·줄 수식');
  const rs = await ev(`const A=window.__app;
    const shapeMap=x=>{ const o={}; for(const m of x.matchAll(/<c r="([A-Z]+)([0-9]+)"([^>]*?)(?:[/]>|>)/g)) o[m[1]+m[2]]=(m[3].match(/s="([0-9]+)"/)||[])[1]||''; return o; };
    const merges=x=>[...x.matchAll(/<mergeCell ref="([^"]+)"/g)].map(m=>m[1]).sort().join(' ');
    const rowTags=x=>[...x.matchAll(/<row [^>]*>/g)].map(m=>m[0].replace(/ spans="[^"]*"/,'')).join('');
    const same=(a,b)=>{ const A1=shapeMap(a),B1=shapeMap(b); return [...new Set([...Object.keys(A1),...Object.keys(B1)])].filter(k=>A1[k]!==B1[k]).length===0&&merges(a)===merges(b)&&rowTags(a)===rowTags(b); };
    return (async()=>{ const out={};
      for(const id of ['101','102']){
        const tpl=await A.loadBaseTemplate(id), F=A.formDefOf(id), base=A.fvDraftStart(tpl,F);
        const run=ops=>{ let x=base; const log=[]; for(const [P,d] of ops){ const r=(d>0?A.seatRowAdd:A.seatRowDel)(x,tpl,F,P,{base}); if(r.why){ log.push('막음'); continue; } x=r.xml; log.push(r.label); } return {x,log}; };
        const lay=x=>A.layoutOf(F,A.sheetCells({...tpl,sheetXml:x}),A.sheetMerges({...tpl,sheetXml:x}));
        // 두 자리 구역(N 3→2)에 다시 넣으면 처음 양식과 칸 서식·병합·줄 높이가 같다 — 새 줄은 안쪽 줄 모양(첫 줄의 굵은 윗선을 본뜨지 않는다)
        const a=run([['N',-1],['N',1]]);
        // D 를 두 자리까지 빼고(더는 막음) 다시 채우면 처음과 같다
        const b=run([['D',-1],['D',-1],['D',-1],['D',-1],['D',1],['D',1],['D',1]].slice(0,id==='101'?7:6));
        // 자리 줄을 많이 빼도 자리 이름 열은 표 쪽(C) — 표 아래 블록(B열 A(CN)~E)이 이기지 않는다
        const c=run([['D',-1],['D',-1],['D',-1],['E',-1],['E',-1],['E',-1],['N',-1]]), Lc=lay(c.x);
        out[id]={N:[a.log.join(','), same(base,a.x)], D:[b.log.includes('막음'), same(base,b.x)], 열:[Lc.labelCol, Lc.sections.map(s=>s.P+s.rows).join(' ')]};
      }
      // 줄마다 제 줄을 보는 수식 — 넣고 빼도 제 줄을 본다
      const tpl=await A.loadBaseTemplate('102'), F=A.formDefOf('102'); let x=A.fvDraftStart(tpl,F);
      for(let r=5;r<=16;r++) x=A.putCell(x,'S'+r,'<f>COUNTA(D'+r+':Q'+r+')</f><v>0</v>','');
      const f=(xx,ref)=>((xx.match(new RegExp('<c r="'+ref+'"[^>]*><f>([^<]*)<'))||[])[1]||'');
      const ad=A.seatRowAdd(x,tpl,F,'D',{base:x}), dl=A.seatRowDel(x,tpl,F,'D',{base:x});
      out.수식=[f(ad.xml,'S8'),f(ad.xml,'S9'),f(dl.xml,'S7')];
      return out; })()`, 30000);
  for (const id of ['101', '102']) {
    eq(`${id} 두 자리 구역에 다시 넣으면 처음 양식과 같다 (선·병합·줄 높이)`, rs[id].N, ['C,C', true]);
    eq(`${id} 두 자리까지만 빼고 다시 채우면 처음과 같다`, rs[id].D, [true, true]);
    eq(`${id} 자리 줄을 많이 빼도 자리 이름 열은 표 쪽`, rs[id].열, [3, 'D2 E2 N2']);
  }
  eq('줄마다 제 줄을 보는 수식은 넣고 빼도 제 줄을 본다', rs.수식, ['COUNTA(D8:Q8)', 'COUNTA(D9:Q9)', 'COUNTA(D7:Q7)']);

  step('30c 자리 줄 — 저장 전 채워 보기 · 새 자리 이름은 종이 순서');
  const dp = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), sun=new Date(2026,8,6);
    const t=ref=>{ const u=document.querySelector('#fvSheet [data-ref="'+ref+'"]'); return u?u.textContent:''; };
    return (async()=>{ const out={};
      setup('101'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form');
      await A.openFormView('current'); await A.renderFormView();
      await A.fvRowOp('D',1); await sleep(200);
      A.fvSet('mode','fill'); await sleep(600);
      out.채워보기={E10:t('E10'), D10:t('D10'), D9:t('D9'), 안내:/저장하지 않은/.test(document.querySelector('#fvSide').textContent)};
      out.새지않음=[A.seatsFor('D'), A.weekData(sun).some(d=>d.secs&&d.secs.D.byLabel.E)];
      A.fvSet('mode','map'); await sleep(200); await A.fvSave(); await sleep(400);
      { const r=await A.buildWeekXlsx(sun), y=A.sheetCells({...r.tpl,sheetXml:r.xml}); out.내보내기={E10:y.E10, D10:y.D10, D9:y.D9, 안내:true}; }
      A.undoAny(); await sleep(300); A.show('week');
      const tpl=await A.loadBaseTemplate('101'), F=A.formDefOf('101'); let x=A.fvDraftStart(tpl,F);
      const lab={5:'CN',6:'A',7:'B',8:'C',9:'D',11:'CN',12:'A',13:'B',14:'C',15:'D',16:'CN',17:'A',18:'B'};
      for(const r in lab) x=A.putCell(x,'C'+r,'<is><t>'+lab[r]+'</t></is>','inlineStr');
      const d=A.seatRowAdd(x,tpl,F,'D',{base:x}), n=A.seatRowAdd(x,tpl,F,'N',{base:x});
      out.이름=[d.label, A.sheetCells({...tpl,sheetXml:d.xml}).C10, n.label, A.sheetCells({...tpl,sheetXml:n.xml}).C19];
      return out; })()`, 30000);
  eq('저장 전 채워 보기 = 저장 뒤 엑셀 내보내기 (넣은 D 자리에 여섯째 사람, 방은 여섯 자리로)', dp.채워보기, dp.내보내기);
  eq('채워 보기 — 새 F 줄에 여섯째 사람', [dp.채워보기.E10, dp.채워보기.안내], ['한이', true]);
  eq('채워 보기는 저장된 자리 수를 건드리지 않는다', dp.새지않음, [5, false]);
  eq('CN·A·B… 로 적은 양식 — 새 자리 이름은 종이 순서대로 (D 다음 E, N 은 B 다음 C)', dp.이름, ['E', 'E', 'C', 'C']);

  step('30d 글자 고치기 — 조각 서식 · 그대로 확인 · 곳 수 · 줄바꿈 서식 · 옆 상자 줄');
  const tx = await ev(`const A=window.__app; ${setupWeek}
    const sleep=ms=>new Promise(r=>setTimeout(r,ms)), sun=new Date(2026,8,6), NL=String.fromCharCode(10);
    return (async()=>{

      const clickRef=async ref=>{ const xs=document.querySelector('#fvSheet .xs'), M=A.fvCache.M, m=ref.match(/^([A-Z]+)([0-9]+)$/), c=A.colNum(m[1]), r=+m[2];
        const rc=xs.getBoundingClientRect(), k=rc.width/A.fvCache.w;
        xs.dispatchEvent(new MouseEvent('click',{clientX:rc.left+(M.X[c]+3)*k,clientY:rc.top+(M.Y[r]+3)*k,bubbles:true})); await sleep(200); };
      const typeText=async t=>{ document.querySelector('#mdTextBtn').click(); await sleep(50); const i=document.querySelector('#mdInput'), v0=i.value;
        i.value=typeof t==='function'?t(v0):t; document.querySelector('#mdOk').click(); await sleep(250); return v0; };
      const runsOf=(xml,ref)=>{ const raw=(xml.match(new RegExp('<c r="'+ref+'"[^>]*?(?:[/]>|>[^]*?<[/]c>)'))||[''])[0];
        return [...raw.matchAll(/<r>([^]*?)<[/]r>/g)].map(m=>[/FFFF0000/.test(m[1])?'R':(/002060/.test(m[1])?'N':'-'), /<b[/]>/.test(m[1])?'B':'', ((m[1].match(/<t[^>]*>([^]*?)<[/]t>/)||[])[1]||'').slice(0,14)]); };
      const out={};
      // (a) 82 F13 두 곳 고치기
      setup('82'); A.wkSunday=new Date(sun); A.show('admin'); A.pickAdmin('form'); await A.openFormView('current'); await A.renderFormView();
      out.f13전=runsOf(A.fvDraft?A.fvDraft.xml:A.TPL.sheetXml,'F13');
      await clickRef('H13'); const v0=await typeText(v=>v.replace('낙상예방활동','낙상 예방활동').replace('비치의약품','비치 의약품'));
      out.f13후=runsOf(A.fvDraft.xml,'F13');
      // (d) C11 줄바꿈 → 칸 서식 줄바꿈
      await clickRef('C11'); await typeText('경보반,소화반'+NL+'대피유도반');
      out.c11=runsOf(A.fvDraft.xml,'C11');
      { const t=await A.loadTemplate(); const w=await A.applyWrapStyles(t,A.fvDraft.xml); const s=(w.xml.match(/<c r="C11"[^>]*s="([0-9]+)"/)||[])[1];
        const xfs=(w.styles||'').match(/<cellXfs[^>]*>([^]*?)<[/]cellXfs>/); const xl=xfs?xfs[1].match(/<xf[^]*?(?:[/]>|<[/]xf>)/g):[]; out.c11wrap=[s, /wrapText="1"/.test(xl[+s]||''), runsOf(w.xml,'C11').length]; }
      A.fvDiscard();
      // (b) 101 B32 그대로 확인 / (c) 떠날 때 곳 수 / (e) 옆 상자 줄
      A.store.forms={}; setup('101'); A.show('admin'); A.pickAdmin('form'); await A.openFormView('current'); await A.renderFormView();
      await clickRef('B32'); await typeText(v=>v);
      out.그대로=[A.fvDirty(), A.fvCellEdits(), A.fvChangedCount()];
      await clickRef('A1'); await typeText(v=>v+' (9월)');
      await A.fvRowOp('E',1); await sleep(150); await A.fvRowOp('E',-1); await sleep(150); await A.fvRowOp('D',1); await sleep(150);
      out.곳수=[A.fvChangedCount(), (document.querySelector('#fvSide .fvEdit')||{}).textContent.match(/고친 칸[^—]*/)[0].trim()];
      out.줄=[...document.querySelectorAll('#fvSide .fvRow span b, #fvSide .fvEdit > span b')].map(b=>getComputedStyle(b).display);
      out.머리=[...document.querySelectorAll('#fvSide .fvEdit > b:first-child')].map(b=>getComputedStyle(b).display);
      A.fvDiscard();
      // (f) 한 조각 서식 제목
      { const tpl=await A.loadBaseTemplate('101'); let x=A.putCell(tpl.sheetXml,'A1','<is><r><rPr><b/><sz val="24"/><color rgb="FFFF0000"/></rPr><t>병실 배정표</t></r></is>','inlineStr');
        const y=A.setCellPlain(x,tpl,'A1','병실 배정표 (9월)',''), z=A.setCellTag(x,tpl,'A1','{{날짜:M월 D일}}',false);
        out.한조각=[runsOf(y,'A1'), runsOf(z,'A1')]; }
      A.store.forms={}; A.show('week');
      return out;

    })()`, 60000);
  eq('82 인계사항 — 두 곳을 한 번에 고쳐도 그 사이 빨강·남색·굵은 글자는 제 서식', tx.f13후, [
    ['R', '', '&lt;인계사항&gt;'], ['-', '', '\n1. 낙상 예방활동_시설'], ['R', 'B', '(매월 17일)'], ['-', '', '\n2'],
    ['N', '', '. 휴가, 생휴 전 전산 '], ['-', '', '\n3. 정기 낙상/욕창 평'], ['R', 'B', '4. 비치 의약품 유효기간']]);
  eq('조각 서식 칸에 줄을 바꾸면 조각은 그대로, 칸 서식에 줄바꿈이 켜진다', [tx.c11, tx.c11wrap[1], tx.c11wrap[2]],
    [[['R', 'B', '경보반'], ['-', 'B', ',소화반\n대피유도반']], true, 2]);
  eq('줄바꿈이 든 칸을 고치지 않고 확인하면 고친 것이 아니다', tx.그대로, [false, 0, 0]);
  eq('떠날 때 묻는 곳 수 = 옆 상자 (넣었다 뺀 자리 줄은 세지 않는다)', tx.곳수, [2, '고친 칸 1곳 · 자리 줄 D +1']);
  eq('옆 상자 — 자리 수·곳 수는 제 줄에 붙고 머리글만 한 줄', [tx.줄.every(d => d === 'inline'), tx.머리], [true, ['block', 'block']]);
  eq('한 조각 서식 제목(굵은 빨강)은 글자를 고치거나 표시자를 붙여도 서식 그대로', tx.한조각,
    [[['R', 'B', '병실 배정표 (9월)']], [['R', 'B', '병실 배정표'], ['R', 'B', '\n{{날짜:M월 D일}}']]]);

  // ── 31. 102 CRN — 방이 고정이 아니다 (2026-10-01) ─────────────────────
  // CRN 은 어느 방이든 본다(A·B·C·D — /CRN 은 사람에 붙는다). 차지를 첫 자리(A)에 못 박았더니 CRN 이 바뀌는 날마다 새 CRN 이 A 로 끌려가고
  // A 사람이 밀려 뒤가 하나도 이어지지 않았다. 손으로 CRN 을 B 로 옮겨도 다음 날 다시 A 로 돌아갔다.
  step('31 102 CRN 자리');
  const crnSetup = `const crnSetup=()=>{ A.setFormId('102'); A.setWard('102'); const s=A.store;
      s.order=['김차지','이에이','박비','최씨','정새로']; s.cells={}; s.ovr={}; s.ovrPair={}; s.roomOv={}; s.presetDay={}; s.seedManual={};
      s.unit={}; s.relief={}; s.trainee={}; s.trOv={}; s.evRules=[]; s.daily={}; s.banRooms={};
      const plan={김차지:['D','OF','D','D','D'],이에이:['D','D','D','D','D'],박비:['D','D','D','D','D'],최씨:['D','D','D','D','D'],정새로:['OF','D','OF','OF','OF']};
      const days=['2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10'];
      for(const n of s.order){ s.cells[n]={}; days.forEach((iso,i)=>{ s.cells[n][iso]=plan[n][i]; }); }
      A.store=s; A.recompute();
      A.openPick('김차지','2026-09-09',10,10); A.pickChoose('A'); };`;   // 9/9 — CRN 김차지가 실제로는 B 방을 봤다
  const crn102 = await ev(`const A=window.__app; ${crnSetup} crnSetup();
    return (async()=>{ const out={};
      const r=await A.buildWeekXlsx(new Date(2026,8,6)); const c=A.sheetCells({...r.tpl,sheetXml:r.xml});
      for(const k of ['D','F','H','J','L']) out[k]=[5,6,7,8].map(i=>c[k+i]||'');
      A.wkSunday=new Date(2026,8,6); A.show('week');
      out.scr=[...document.querySelectorAll('#wkTable tr')].map(tr=>[...tr.children].map(td=>(td.textContent||'').trim()))
        .map(r=>r.filter(v=>/김차지|이에이|박비|최씨|정새로/.test(v))).filter(r=>r.length);   // 줄마다 일~목 다섯 칸
      // 하루 어싸인표 — 첫 줄은 그 자리 사람, CRN 은 앉은 줄에 /CRN
      A.DAYTPL=null;
      { const d=await A.buildDayDoc('2026-09-07'), M=A.dayLayout(d.doc).main;
        out.day=M.rows.slice(0,4).map(row=>{ const x=M.m.at(row.r,M.shifts.D.nurse); return x?x.text:null; }); }
      // 자동 맵핑 — 자리마다 {{차지: /CRN}}, 채운 결과는 내장 채우기와 같다
      const tpl=await A.loadBaseTemplate('102'), cells=A.sheetCells(tpl), merges=A.sheetMerges(tpl);
      const days=A.weekData(new Date(2026,8,6)), L=A.layoutOf(A.formDefOf('102'),cells,merges);
      const x1=A.fillForm102(tpl,L,days), sh=A.detectFormShape(cells,merges), am=A.autoMap(tpl,sh);
      const t2={...tpl,sheetXml:am.xml}, c2=A.sheetCells(t2), xf=await A.dateStyleSet(tpl);
      out.tags=['D5','D6','D7','D8','D14','D15','D16'].map(k=>/[{][{]차지: [/]CRN[}][}]$/.test(c2[k]||''));
      out.same=x1===A.fillByPlaceholders(t2,c2,A.layoutOf({kind:sh.kind},c2,merges),days,{dateXf:xf});
      // 그 전에 [맵핑 저장]한 양식 — {{차지}} 가 첫 자리에만 있어도 표시가 CRN 을 따라간다
      let xml=am.xml; for(const k of ['D6','D7','D8','D15','D16']) xml=A.setCellStr(xml,k,c2[k].replace(/[{][{]차지: [/]CRN[}][}]/,''));
      const t3={...tpl,sheetXml:xml}, c3=A.sheetCells(t3);
      out.oldSame=x1===A.fillByPlaceholders(t3,c3,A.layoutOf({kind:sh.kind},c3,merges),days,{dateXf:xf});
      // CRN 맡기기 — 자리는 그대로, 근무가 DC 로 (다른 DC 는 D 로)
      A.openPick('박비','2026-09-10',10,10);
      out.btn=[...document.querySelectorAll('#pick button')].some(b=>b.textContent==='CRN 맡기기');
      out.btnTitle=([...document.querySelectorAll('#pick button')].find(b=>b.textContent==='CRN 맡기기')||{}).title||'';
      out.who=[...document.querySelectorAll('#pick .who')].map(b=>b.textContent);
      A.pickCrn(); out.crnToast=(document.querySelector('#toast')||{}).textContent||'';
      out.cells=['김차지','이에이','박비','최씨'].map(n=>A.store.cells[n]['2026-09-10']);
      { const r2=await A.buildWeekXlsx(new Date(2026,8,6)); const c4=A.sheetCells({...r2.tpl,sheetXml:r2.xml}); out.L2=[5,6,7,8].map(i=>c4['L'+i]||''); }
      // 넷째 자리(D)를 보는 최씨에게 CRN — D 그대로 (예전엔 A·B·C 만 허락해 최씨가 앞으로 끌려갔다), 다음 날도 D
      A.openPick('최씨','2026-09-10',10,10); A.pickCrn();
      for(const [n,c] of [['김차지','D'],['이에이','D'],['박비','D'],['최씨','DC'],['정새로','OF']]) A.store.cells[n]['2026-09-11']=c;
      A.recompute();
      { const r2=await A.buildWeekXlsx(new Date(2026,8,6)); const c4=A.sheetCells({...r2.tpl,sheetXml:r2.xml});
        out.L3=[5,6,7,8].map(i=>c4['L'+i]||''); out.N3=[5,6,7,8].map(i=>c4['N'+i]||''); }
      out.seats=['D','E','N'].map(P=>A.crnSeats(P));
      // 다섯 명인 날 — 칸 밖(대체) 사람에게 CRN 을 맡기면 칸으로 올라오고 한 사람이 밀린다. 안내가 그렇게 말해야 한다 (교차 검토)
      for(const n of ['김차지','이에이','박비','최씨','정새로']) A.store.cells[n]['2026-09-12']='D';
      A.recompute();
      { const d=A.dayInfo('2026-09-12').D, off=d.labels['D']||d.extra[0];
        A.openPick(off,'2026-09-12',10,10);
        out.offTitle=([...document.querySelectorAll('#pick button')].find(b=>b.textContent==='CRN 맡기기')||{}).title||'';
        A.pickCrn(); out.offToast=(document.querySelector('#toast')||{}).textContent||'';
        const d2=A.dayInfo('2026-09-12').D; out.offSeated=['차지','A','B','C'].some(l=>d2.labels[l]===off); }
      // 옛 102 양식처럼 종이에 CRN 자리(D(CRN))가 따로 있으면 차지는 그 자리에 묶인다
      { const base=await A.loadBaseTemplate('102');
        A.store.forms['102']={name:'옛 102.xlsx',b64:A.bytesToB64(A.packXlsx(base,{'xl/worksheets/sheet1.xml':A.setCellStr(base.sheetXml,'C8','D(CRN)')})),savedAt:7,ph:false};
        await A.loadTemplate(); await new Promise(r=>setTimeout(r,50));
        out.묶임=['D','E','N'].map(P=>A.crnFloat(P));
        const r3=await A.buildWeekXlsx(new Date(2026,8,6)); const c5=A.sheetCells({...r3.tpl,sheetXml:r3.xml}); out.옛F=[5,6,7,8].map(i=>c5['F'+i]||'');
        delete A.store.forms['102']; await A.loadTemplate(); await new Promise(r=>setTimeout(r,50));
        out.풀림=['D','E','N'].map(P=>A.crnFloat(P)); }
      // 지난 어싸인 직접 입력 — 첫 자리도 보통 자리라 고를 수 있다
      A.show('admin'); A.pickAdmin('seed');
      out.seed=[...document.querySelectorAll('#seedTable tr')].slice(1,2).map(tr=>[...tr.querySelectorAll('button')].map(b=>b.textContent).slice(0,5))[0];
      out.seedNote=(document.querySelector('#seedTable td.note:last-child')||{}).textContent||'';
      // 간호사 관리 설명 — 102 는 'CRN 은 자리가 정해져 있지 않다', 101 은 '첫 자리' (교차 검토)
      A.pickAdmin('caps'); { const b=document.querySelector('.apMoreBtn'); if(b&&b.textContent==='자세히') b.click(); }
      out.caps102=(document.querySelector('.apMore')||{}).textContent||'';
      A.setFormId('101'); out.고정101=['D','E','N'].map(P=>A.crnFloat(P));
      A.pickAdmin('caps'); out.caps101=(document.querySelector('.apMore')||{}).textContent||'';
      A.pickAdmin('seed'); out.seed101=[...document.querySelectorAll('#seedTable tr')].slice(1,2).map(tr=>[...tr.querySelectorAll('button')].map(b=>b.textContent).slice(0,5))[0];
      // 방 칸 없는 병동 양식이 첫 자리를 'A(CN)' 으로 적었으면 차지 자리가 있는 것 — 차지는 그 줄 (교차 검토: 예전엔 /CRN 만 찾았다)
      { const base=await A.loadBaseTemplate('102'); let xml=base.sheetXml;
        for(const k of ['C5','C10','C14']) xml=A.setCellStr(xml,k,'A(CN)');
        const t2={...base,sheetXml:xml}, cl=A.sheetCells(t2), mg=A.sheetMerges(t2), sh=A.detectFormShape(cl,mg);
        A.setWard('61'); A.store.forms['61']=Object.assign({name:'61 배정표.xlsx',b64:A.bytesToB64(A.packXlsx(base,{'xl/worksheets/sheet1.xml':xml})),savedAt:7,ph:false},sh,{formName:'61병동 양식'});
        A.setFormId('61'); await A.loadTemplate(); A.recompute(); await new Promise(r=>setTimeout(r,50));
        out.cnKind=sh.kind; out.cnFloat=['D','E','N'].map(P=>A.crnFloat(P));
        const r4=await A.buildWeekXlsx(new Date(2026,8,6)); const c6=A.sheetCells({...r4.tpl,sheetXml:r4.xml});
        out.cnF=[5,6,7,8].map(i=>c6['F'+i]||'');
        const am=A.autoMap(t2,sh), c7=A.sheetCells({...t2,sheetXml:am.xml}); out.cnTags=[c7.D5,c7.D6,/[{][{]차지: [/]CRN[}][}]/.test(am.xml)];
        // 이 양식은 CN 줄에 앉은 사람이 차지 — 맞바꾸면 차지도 바뀐다. 그 뒤 [CRN 맡기기] 는 손으로 옮긴 자리를 풀고 그 사람을 CN 줄로
        // (교차 검토: 예전엔 근무만 DC 로 바뀌고 차지는 그대로였다 — 손으로 옮긴 자리가 표시보다 앞서서)
        const cur=()=>{ const d=A.dayInfo('2026-09-08').D; return {charge:d.charge,at:Object.keys(d.labels).find(l=>d.labels[l]===d.charge)}; };
        const c0=cur().charge; A.openPick(c0,'2026-09-08',10,10); A.pickChoose('C'); out.pinSwap=[c0,cur()];
        const z=['김차지','이에이','박비','최씨'].find(n=>n!==c0&&n!==out.pinSwap[1].charge);
        A.openPick(z,'2026-09-08',10,10); A.pickCrn(); out.pinCrn=[z,cur(),(document.querySelector('#toast')||{}).textContent||''];
        delete A.store.forms['61']; A.setFormId('101'); A.setWard('101'); await A.loadTemplate(); A.recompute(); }
      // 양식 보기 초안에서 자리 줄을 뺐으면 CRN 이 앉을 자리도 그 초안의 줄 수로 (예전엔 저장한 양식 줄 수라 미리보기에서 CRN 이 빠졌다)
      A.setFormId('102'); A.seatOv={D:3,E:4,N:3}; out.draftSeats=A.crnSeats('D'); A.seatOv=null; out.savedSeats=A.crnSeats('D');
      // '대체' 줄이 있는 102 양식 — 다섯째 사람은 대체 줄에 찍힌다. 그 사람에게 CRN 을 맡기면 다른 한 사람이 대체 줄로 내려갈 뿐
      // 인쇄에서 빠지지 않는다 — 안내·알림·확인 카드가 모두 같은 기준(paperSeat) (교차 검토: 알림만 '인쇄 안 됨'이라 했다)
      { crnSetup(); const s=A.store; for(const n of s.order) s.cells[n]['2026-09-08']='D'; A.recompute();
        const base=await A.loadBaseTemplate('102');
        s.forms['102']={name:'대체줄 102.xlsx',b64:A.bytesToB64(A.packXlsx(base,{'xl/worksheets/sheet1.xml':A.setCellStr(base.sheetXml,'A9','대체')})),savedAt:9,ph:false};
        await A.loadTemplate(); await new Promise(r=>setTimeout(r,80)); A.recompute();
        out.subOn=A.paperSeat('D').on('D');
        const who=A.dayInfo('2026-09-08').D.labels['D'];
        A.openPick(who,'2026-09-08',10,10);
        out.subTitle=([...document.querySelectorAll('#pick button')].find(b=>b.textContent==='CRN 맡기기')||{}).title||'';
        A.pickCrn(); out.subToast=(document.querySelector('#toast')||{}).textContent||'';
        A.wkSunday=new Date(2026,8,6); A.show('week');
        out.subWarn=((document.querySelector('#wkWarn')||{}).textContent||'').includes('인쇄에 나오지 않습니다');
        delete s.forms['102']; await A.loadTemplate(); await new Promise(r=>setTimeout(r,50)); }
      // 방 칸 없는 서식(102)도 주지 않을 방이 지켜지지 않으면 확인 카드에 (예전엔 102 만 조용했다)
      { crnSetup(); const s=A.store; s.banRooms={'이에이':s.rooms.map(r=>String(r[0]))}; A.recompute();
        A.wkSunday=new Date(2026,8,6); A.show('week');
        out.banCard=/이에이 — .*주지 않을 방인데 배정됐습니다/.test((document.querySelector('#wkWarn')||{}).textContent||'');
        s.banRooms={}; A.recompute(); }
      A.show('week');
      return out; })()`);
  eq('9/6 — CRN 김차지는 첫 자리', crn102.D, ['김차지 /CRN', '이에이', '박비', '최씨']);
  eq('9/7 — 김차지가 쉬어 CRN 이 이에이로 바뀌어도 이에이는 B 그대로, 빈 A 에 정새로', crn102.F, ['정새로', '이에이 /CRN', '박비', '최씨']);
  eq('9/8 — 김차지가 돌아와 CRN, 제 자리 A 로 · 나머지 그대로', crn102.H, ['김차지 /CRN', '이에이', '박비', '최씨']);
  eq('9/9 — 손으로 CRN 을 B 로 옮겼다 (/CRN 은 사람을 따라간다)', crn102.J, ['이에이', '김차지 /CRN', '박비', '최씨']);
  eq('9/10 — 다음 날도 CRN 은 B, A 사람은 A (예전엔 둘이 다시 뒤바뀜)', crn102.L, ['이에이', '김차지 /CRN', '박비', '최씨']);
  eq('화면이 엑셀과 같다 (자리 · /CRN)', crn102.scr, [0, 1, 2, 3].map(i => ['D', 'F', 'H', 'J', 'L'].map(k => crn102[k][i])));
  // 하루 어싸인표 첫 줄은 CN(차지 번호) 줄 — 종이에서 CRN 이 어느 자리에 앉든 CN 줄에는 CRN 이 선다, 방은 사람을 따라간다 (2026-10-01 교차 검토)
  eq('하루 어싸인표 — CN 줄에는 CRN, 나머지는 종이 자리 순서', crn102.day, ['이에이 /CRN', '정새로', '박비', '최씨']);
  eq('자동 맵핑 — 102 는 자리마다 {{차지: /CRN}}', crn102.tags, [true, true, true, true, true, true, true]);
  ok('자동 맵핑 채우기 = 내장 채우기 (CRN 이 B 에 앉은 주)', crn102.same);
  ok('첫 자리에만 {{차지}} 가 있는 옛 자리표시자 양식도 같게 (표시가 CRN 을 따라간다)', crn102.oldSame);
  ok('이름 클릭 창에 [CRN 맡기기]', crn102.btn);
  eq('이름 클릭 창의 자리 목록에 누가 CRN 인지', crn102.who, ['이에이', '김차지 /CRN', '박비 (본인)', '최씨']);
  eq('CRN 맡기기 — 근무가 DC 로 (다른 사람은 그대로 D)', crn102.cells, ['D', 'D', 'DC', 'D']);
  eq('CRN 맡기기 — 자리는 그대로, /CRN 만 옮겨 간다', crn102.L2, ['이에이', '김차지', '박비 /CRN', '최씨']);
  ok('CRN 맡기기 안내 — 칸에 앉은 사람은 "앉은 자리는 그대로"', /앉은 자리는 그대로/.test(crn102.btnTitle), crn102.btnTitle);
  ok('CRN 맡기기 안내 — 칸 밖 사람은 "양식 줄로 올라가고 … 양식 칸 밖으로 내려갑니다"', /양식 줄로 올라가고.*양식 칸 밖으로 내려갑니다/.test(crn102.offTitle), crn102.offTitle);
  ok('칸 밖 사람이 CRN 이 되면 칸에 앉고, 알림이 밀린 사람을 알려 준다', crn102.offSeated && /양식 칸 밖으로/.test(crn102.offToast), crn102.offToast);
  eq('CRN 은 D 방도 본다 — 넷째 자리 최씨가 CRN 이어도 D 그대로', crn102.L3, ['이에이', '김차지', '박비', '최씨 /CRN']);
  eq('다음 날도 CRN 최씨는 D, 나머지 그대로', crn102.N3, ['이에이', '김차지', '박비', '최씨 /CRN']);
  eq('102 CRN 이 앉을 수 있는 자리 = 종이의 자리 전부 (D·E 넷, N 셋)', crn102.seats,
    [['차지', 'A', 'B', 'C'], ['차지', 'A', 'B', 'C'], ['차지', 'A', 'B']]);
  eq('종이에 D(CRN) 자리가 있는 옛 양식 — D 근무 차지는 그 자리에 묶인다', [crn102.묶임, crn102.옛F], [[false, true, true], ['정새로', '박비', '최씨', '이에이']]);
  eq('양식을 되돌리면 다시 어느 자리든', crn102.풀림, [true, true, true]);
  eq('101 은 차지 자리(A(CN))가 따로 있어 묶인다', crn102.고정101, [false, false, false]);
  ok('간호사 관리 설명 — 102 는 CRN 자리가 정해져 있지 않고 [CRN 맡기기]', /정해져 있지 않습니다/.test(crn102.caps102) && /CRN 맡기기/.test(crn102.caps102), crn102.caps102);
  ok('간호사 관리 설명 — 101 은 차지가 차지 자리(A(CN))', /차지 자리\(A\(CN\)/.test(crn102.caps101) && !/CRN 맡기기/.test(crn102.caps101), crn102.caps101);
  eq('A(CN) 을 적은 방 칸 없는 병동 양식 — 102 모양이어도 차지는 CN 줄에 묶인다', [crn102.cnKind, crn102.cnFloat], ['102', [false, false, false]]);
  eq('그 양식의 9/7 — CRN 이에이가 A(CN) 줄, /CRN 은 붙이지 않는다(종이가 CN 이라 적었다)', crn102.cnF, ['이에이', '정새로', '박비', '최씨']);
  eq('그 양식의 자동 맵핑 — CN 줄이 차지, 자리마다 {{차지: /CRN}} 을 꽂지 않는다', crn102.cnTags, ['{{이름:D.차지}}', '{{이름:D.A}}', false]);
  eq('A(CN) 양식 — 맞바꾸면 CN 줄에 앉은 사람이 차지', [crn102.pinSwap[1].at, crn102.pinSwap[1].charge !== crn102.pinSwap[0]], ['차지', true]);
  eq('A(CN) 양식 — 맞바꾼 뒤에도 [CRN 맡기기] 한 사람이 CN 줄의 차지', [crn102.pinCrn[1].charge, crn102.pinCrn[1].at], [crn102.pinCrn[0], '차지']);
  ok('A(CN) 양식 — 알림이 자리가 바뀐 사람을 적는다', /자리 바뀜/.test(crn102.pinCrn[2]), crn102.pinCrn[2]);
  ok('CRN 맡기기 — 자리가 그대로면 알림에 "자리 바뀜" 이 없다', !/자리 바뀜/.test(crn102.crnToast), crn102.crnToast);
  eq('양식 보기 초안에서 D 줄을 하나 빼면 CRN 자리도 셋 (저장한 양식은 넷)', [crn102.draftSeats, crn102.savedSeats], [['차지', 'A', 'B'], ['차지', 'A', 'B', 'C']]);
  ok('대체 줄 있는 102 — 다섯째 자리는 종이에 찍힌다', crn102.subOn);
  ok('대체 줄 있는 102 — 안내는 "대체 줄로 내려갑니다"', /대체 줄로 내려갑니다/.test(crn102.subTitle), crn102.subTitle);
  ok('대체 줄 있는 102 — 알림에 "인쇄 안 됨" 이 없다', !/인쇄 안 됨/.test(crn102.subToast) && /CRN/.test(crn102.subToast), crn102.subToast);
  ok('대체 줄 있는 102 — 확인 카드도 "인쇄에 나오지 않습니다" 라 하지 않는다', !crn102.subWarn);
  ok('102 도 주지 않을 방이 지켜지지 않으면 확인 카드에', crn102.banCard);
  eq('지난 어싸인 직접 입력 — 102 는 첫 자리 A 도 고른다', crn102.seed, ['A', 'B', 'C', 'D', '없음']);
  ok('지난 어싸인 직접 입력 — 102 안내는 CRN 도 앉았던 자리를 고르라고', /CRN/.test(crn102.seedNote), crn102.seedNote);
  eq('지난 어싸인 직접 입력 — 101 은 그대로 (차지 자리 빼고)', crn102.seed101, ['B', 'C', 'D', 'E', '없음']);

  // ── 32. 원칙·차지 검증 (2026-10-01, 결정 2-43) ─────────────────────────────
  // 차지 방에 주지 않을 방이 걸려도 차지는 선임(예전엔 말없이 차지에서 뺐다), 셋이 돌아가며 바꿔야 풀리는 금지 방도 푼다(예전엔 '대안이 없습니다'),
  // 남은 위반은 카드가 이유를 적는다
  step('32 원칙·차지 검증');
  const v32 = await ev(`const A=window.__app;
    const setup=(id)=>{ A.setFormId(id); A.setWard(id); const s=A.store;
      s.order=['김차지','이에이','박비','최씨','정디']; s.cells={}; s.ovr={}; s.ovrPair={}; s.roomOv={}; s.presetDay={}; s.seedManual={};
      s.unit={}; s.relief={}; s.trainee={}; s.trOv={}; s.evRules=[]; s.daily={}; s.banRooms={};
      for(const n of s.order) s.cells[n]={'2026-09-06':'D'};
      s.presets={}; s.presetPlan={}; A.store=s; A.resetSchemes(); return A.store; };   // 앞 검사가 바꾼 방 구성을 기본으로
    const card=()=>{ A.wkSunday=new Date(2026,8,6); A.show('week'); return (document.querySelector('#wkWarn')||{}).textContent||''; };
    const out={};
    for(const id of ['101','122']){
      const s=setup(id), R=l=>A.roomTokens(A.roomsFor('D',5,l,'2026-09-06'));
      // ① 최선임 김차지의 주지 않을 방이 차지 방 — 그래도 김차지가 차지, 카드는 '차지 자리의 방'
      s.banRooms={'김차지':[R('차지')[0]]}; A.recompute();
      out[id+'charge']=A.dayInfo('2026-09-06').D.charge;
      const c1=card(); out[id+'chargeCard']=/김차지 — .*주지 않을 방인데 배정됐습니다\\. 차지 자리의 방이라 차지가 봅니다/.test(c1);
      out[id+'noFalse']=!/대안이 없습니다/.test(c1);
      // ② 셋이 돌아가야 풀리는 금지 방 — 카드에 아무도 안 뜬다
      s.banRooms={'이에이':[...R('C'),...R('D')],'박비':[...R('B'),...R('C'),...R('D')]}; A.recompute();
      const L=A.dayInfo('2026-09-06').D.labels; out[id+'rot']=[L.A,L.B];
      out[id+'rotCard']=/주지 않을 방인데/.test(card());
      // ③ 손으로 금지 방 자리로 옮기면 — '손으로 옮긴 자리입니다'
      s.banRooms={'최씨':[...R('A')]}; A.recompute();
      A.openPick('최씨','2026-09-06',10,10); A.pickChoose('A');
      out[id+'hand']=/최씨 — .*주지 않을 방인데 배정됐습니다\\. 손으로 옮긴 자리입니다/.test(card());
    }
    A.show('week'); return out;`);
  for (const id of ['101', '122']) {
    eq(id + ' 차지 방에 최선임의 주지 않을 방 — 그래도 최선임이 차지', v32[id + 'charge'], '김차지');
    ok(id + ' 그 경우 카드는 "차지 자리의 방이라 차지가 봅니다"', v32[id + 'chargeCard']);
    ok(id + ' 카드에 "대안이 없습니다" 가 없다', v32[id + 'noFalse']);
    eq(id + ' 셋이 돌아가야 풀리는 금지 방 — 박비가 A, 이에이가 B', v32[id + 'rot'], ['박비', '이에이']);
    ok(id + ' 그 날 주지 않을 방 카드가 뜨지 않는다', !v32[id + 'rotCard']);
    ok(id + ' 손으로 금지 방 자리로 옮기면 카드는 "손으로 옮긴 자리입니다"', v32[id + 'hand']);
  }

  // ── 33. 실시간 수정·칸 표기·설정 (2026-10-01, 결정 2-44) ───────────────────────────
  // 맞바꾼 상대가 빠지면 남은 반쪽도 풀린다 · 근무 바꾸기로 DC 를 주면 다른 DC 는 D · 카드는 손으로 정한 자리 탓을 그대로 말한다 ·
  // 칸의 D/A 는 배정표 종이의 자리 이름 · 새 간호사는 차지 없이 · 원칙 4 를 끄면 3 이 돌아온다 · '1호' 표기 · 그날 방 수정은 그 인원수일 때만
  step('33 실시간 수정·칸 표기·설정');
  const v33 = await ev(`const A=window.__app, D='2026-09-06';
    const setup=(id,n)=>{ A.setFormId(id); A.setWard(id); const s=A.store;
      s.order=['김차지','이에이','박비','최씨','정디','한막내'].slice(0,n||5); s.cells={}; s.ovr={}; s.ovrPair={}; s.roomOv={}; s.roomOvCnt={};
      s.presetDay={}; s.seedManual={}; s.unit={}; s.relief={}; s.trainee={}; s.trOv={}; s.evRules=[]; s.daily={}; s.banRooms={}; s.caps={}; s.hidden={};
      s.rules={keepSameShift:true,keepAcrossShift:true,keepAfterOff:true,bounceAfterOff:false};
      for(const nm of s.order) s.cells[nm]={[D]:'D'};
      s.presets={}; s.presetPlan={}; A.store=s; A.resetSchemes(); A.recompute(); return A.store; };
    const day=()=>A.dayInfo(D).D, seat=nm=>{ const L=day().labels; for(const l in L) if(L[l]===nm) return l; return null; };
    // 카드를 다 펼쳐서 읽는다 — 좁은 화면에선 접혀 첫 줄만 보인다
    const card=()=>{ A.wkSunday=new Date(2026,8,6); A.show('week');
      for(let i=0;i<3;i++){ const f=document.querySelector('#wkWarn.shut .fold')||document.querySelector('#wkWarn .items.clip ~ .more')||document.querySelector('#wkWarn .more');
        if(!f||!/자세히|더 보기/.test(f.textContent)) break; f.click(); }
      return (document.querySelector('#wkWarn')||{}).textContent||''; };
    const pick=(nm,fn)=>{ A.openPick(nm,D,10,10); fn(); };
    const out={};
    for(const id of ['101','122','82']){
      // ① 최씨를 차지 자리로 맞바꾼 뒤 최씨가 OF — 김차지가 차지 자리로 돌아온다, [효력 없는 교체 정리]는 둘 다 지운다
      let s=setup(id);
      pick('최씨',()=>A.pickChoose('차지'));
      out[id+'swap']=[day().charge,seat('김차지')!=='차지'];
      pick('최씨',()=>A.pickShift('OF'));
      out[id+'stale']=[day().charge,seat('김차지')];
      out[id+'audit']=A.ovrAudit().bad.length;
      A.pruneOvr(); out[id+'pruned']=Object.keys(A.store.ovr).length;
      // ② 맞바꾼 사람을 명부에서 지우면 상대의 고정도 풀린다
      s=setup(id);
      pick('최씨',()=>A.pickChoose('차지'));
      A.applyNurseName(A.store.order.indexOf('최씨'),null); A.recompute();
      out[id+'del']=[day().charge,!!((A.store.ovr[D]||{}).D||{})['김차지']];
      // ③ 김차지 DC 인 날 정디 → 근무 바꾸기 DC: 정디가 차지, 김차지는 D. 표시가 둘이면 카드
      s=setup(id); s.cells['김차지'][D]='DC'; A.recompute();
      pick('정디',()=>A.pickShift('DC'));
      out[id+'dc']=[day().charge,seat('정디'),A.store.cells['김차지'][D]];
      s.cells['김차지'][D]='DC'; A.recompute();
      out[id+'dc2']=/차지 표시[(]DC[)]가 2명입니다 — 김차지, 정디[.] 김차지가 차지입니다/.test(card());
      // ④ 차지 못 하는 박비를 손으로 차지 자리에 — 카드는 손으로 정한 자리 탓, 단추로 풀면 김차지
      s=setup(id); s.caps={'박비':['D','E','N']}; A.recompute();
      pick('박비',()=>A.pickChoose('차지'));
      const c4=card();
      out[id+'hand']=[day().charge,/박비 — 자격 없이 차지입니다[.] 배정표에서 손으로 차지 자리로 정해 두었기 때문입니다/.test(c4),/차지 가능한 사람이 없어/.test(c4),
        !!document.querySelector('#wkWarn button.inl[onclick^="clearOvrDay"]')];
      A.clearOvrDay(D,'D'); out[id+'cleared']=day().charge;
      // ⑤ 근무표 칸의 D/x 는 배정표 종이의 자리 이름
      s=setup(id);
      const at=lb=>{ s.cells['정디'][D]=lb; A.recompute(); const l=seat('정디'); return l?A.FORM_LBL(l,'D'):null; };
      out[id+'cellA']=at('D/A'); out[id+'cellB']=at('D/B');
      out[id+'cellCN']=at('D/CN'); out[id+'cnCard']=/정디 — 근무표 칸의 'D[/]CN': .*차지[(]CRN[)]는 자리가 아니라 근무를 DC 로 적습니다/.test(card());
      out[id+'cellF']=[at('D/F'),/정디 — 근무표 칸의 'D[/]F': 이 양식에 'F' 자리가 없습니다/.test(card())];
      s.cells['정디'][D]='DC/B'; A.recompute();
      out[id+'dcB']=[day().charge,seat('정디'),/정디 — 근무표 칸의 'DC[/]B': DC 는 차지 자리에 앉으므로/.test(card())];
    }
    // 122 야간은 A 가 차지 자리 — N/A 는 차지 자리, N/B 는 그다음
    { const s=setup('122'); for(const nm of s.order) s.cells[nm][D]='N'; s.cells['정디'][D]='N/B'; A.recompute();
      const L=A.dayInfo(D).N.labels; out.n122=Object.keys(L).find(l=>L[l]==='정디'); }
    // 101: 4명인 날 D/E(다섯째 자리) — 그 날 자리가 없다고 알린다
    { const s=setup('101',4); s.cells['정디']={[D]:'D'}; s.order=['김차지','이에이','박비','정디']; s.cells['정디'][D]='D/E'; A.recompute();
      out.e4=/정디 — 근무표 칸에 적은 자리 'D[/]E' 에 앉지 못했습니다[.] 그 날 D 는 4자리라 E 자리가 없습니다/.test(card()); }
    // 102: D/A 는 종이 A 자리(CRN 자리를 정하는 게 아니다), D/CN 은 없는 자리
    { const s=setup('102'); s.cells['정디'][D]='D/A'; A.recompute();
      out.a102=[A.FORM_LBL(seat('정디'),'D'),day().charge];
      s.cells['정디'][D]='D/CN'; A.recompute(); out.cn102=/차지[(]CRN[)]는 자리가 아니라 근무를 DC 로 적습니다/.test(card()); }
    // ⑥ 새 간호사 — 가능 근무를 정해 둔 병동이면 차지 없이, 근무표의 NC 는 켠다. 처음 시작(가능 근무 없음)은 전부
    { let s=setup('101'); s.caps={'박비':['D','E','N']};
      const was=window.prompt; window.prompt=()=>'새간호'; A.addNurse(); window.prompt=was;
      out.newCaps=A.store.caps['새간호'];
      s.order.push('새둘'); A.capsForNew('새둘',{'2026-09-07':'NC'}); out.newNC=A.store.caps['새둘'];
      s=setup('101'); s.order.push('새셋'); out.fresh=[A.capsForNew('새셋',{}),A.store.caps['새셋']||null]; }
    // ⑦ 원칙 4 를 켰다 끄면 3 이 돌아오고, 되돌리기가 된다. 파일의 원칙 값은 열 때 정리
    { setup('101'); A.setRule('bounceAfterOff',true); const r1={...A.store.rules};
      A.setRule('bounceAfterOff',false); const r2={...A.store.rules};
      A.undoAny(); const r3={...A.store.rules};
      out.rules=[r1.keepAfterOff,r1.bounceAfterOff,r2.keepAfterOff,r2.bounceAfterOff,r3.keepAfterOff,r3.bounceAfterOff];
      A.store.rules={keepSameShift:true,keepAfterOff:true,bounceAfterOff:true}; A.migrateStore(); out.norm={...A.store.rules}; }
    // 우리 병동 표기로 등록한 'D/E' 는 통째로 그 표기 — 자리로 쪼개지 않는다
    { setup('101'); A.store.custom={'D/E':{p:'rest'}}; out.whole=(A.parseCellRaw('D/E')||{}).code; out.split=(A.parseCellRaw('N/E')||{}).label; A.store.custom={}; }
    // ⑧ 방 표기 — '1호, 2호' 와 '1~2호' 는 '1, 2' 와 같다
    out.ho=[A.roomTokens('1호, 2호'),A.roomTokens('1~2호'),A.roomTokens('1001호')];
    // ⑨ 5명일 때 고친 차지 방은 4명인 날 쓰지 않고(카드), 5명으로 돌아오면 다시 쓴다
    { const s=setup('101'); const base=A.roomsFor('D',5,'차지',D), base4=A.roomsFor('D',4,'차지',D);
      A.openRoomPick({kind:'day',iso:D,P:'D',l:'차지'},10,10);
      const add=A.store.rooms.map(r=>String(r[0])).find(r=>!A.roomTokens(base).map(A.roomFull).includes(r));
      A.toggleRoom(add); const ed5=A.roomsFor('D',5,'차지',D);
      s.cells['정디'][D]='OF'; A.recompute();
      out.rov=[ed5!==base,A.store.roomOvCnt[D].D['차지'],A.roomsFor('D',4,'차지',D)===base4,
        /그날 방 수정[(]A[(]CN[)] 자리[)]은 5명일 때 고친 것이라 지금 4명인 배정에는 쓰지 않았습니다/.test(card())];
      s.cells['정디'][D]='D'; A.recompute(); out.rovBack=A.roomsFor('D',5,'차지',D)===ed5; }
    A.show('week'); return out;`);
  // 82 는 차지가 자리에 묶이지 않는다(결정 2-45) — 차지 자리(종이 A)로 맞바꿔도 차지는 사람 그대로, D/CN 은 없는 자리, DC/B 는 B 에 앉은 차지
  for (const id of ['101', '122', '82']) {
    const fl = id === '82';
    eq(id + (fl ? ' 최씨를 첫 자리로 맞바꿔도 차지는 김차지 (82 는 차지가 자리에 묶이지 않는다)' : ' 최씨를 차지 자리로 맞바꾸면 최씨가 차지'), v33[id + 'swap'], [fl ? '김차지' : '최씨', true]);
    eq(id + ' 그 뒤 최씨가 OF — 김차지가 차지 자리로 돌아온다', v33[id + 'stale'], ['김차지', '차지']);
    eq(id + ' [효력 없는 교체 정리]가 세는 것 — 최씨와 남은 반쪽 김차지', v33[id + 'audit'], 2);
    eq(id + ' 정리하면 그 날 교체가 하나도 안 남는다', v33[id + 'pruned'], 0);
    eq(id + ' 맞바꾼 사람을 명부에서 지우면 상대 고정도 풀린다', v33[id + 'del'], ['김차지', false]);
    eq(id + ' 근무 바꾸기로 정디를 DC — 정디가 차지 자리, 김차지는 D', v33[id + 'dc'], ['정디', '차지', 'D']);
    ok(id + ' DC 가 둘인 날 카드가 알린다', v33[id + 'dc2']);
    eq(id + (fl ? ' 차지 못 하는 사람을 손으로 첫 자리에 — 차지는 김차지 그대로, 카드 없음' : ' 차지 못 하는 사람을 손으로 차지 자리에 — 카드는 손으로 정한 탓 + 풀기 단추'),
      v33[id + 'hand'], fl ? ['김차지', false, false, false] : ['박비', true, false, true]);
    eq(id + ' [이 날 D 교체 풀기] 뒤에는 김차지가 차지', v33[id + 'cleared'], '김차지');
    eq(id + ' D/B 는 종이 B 자리', v33[id + 'cellB'], 'B');
    if (fl) ok(id + ' D/CN — 차지가 자리에 묶이지 않아 없는 자리, 근무를 DC 로 적으라고 알린다', v33[id + 'cnCard']);
    else eq(id + ' D/CN 은 차지 자리', v33[id + 'cellCN'], { 101: 'A(CN)', 122: 'CN' }[id]);
    eq(id + ' D/F(없는 자리)는 고정 안 하고 카드가 알린다', v33[id + 'cellF'], [v33[id + 'cellF'][0], true]);
    eq(id + (fl ? ' DC/B — 차지가 B 자리에 앉는다(카드 없음)' : ' DC/B — DC 가 이긴다(차지 자리), 카드가 알린다'), v33[id + 'dcB'], fl ? ['정디', 'A', false] : ['정디', '차지', true]);
  }
  eq('101 D/A 는 A(CN) 자리', v33['101cellA'], 'A(CN)');
  eq('122 D/A 는 A 자리', v33['122cellA'], 'A');
  eq('82 D/A 는 A 자리', v33['82cellA'], 'A');
  eq('122 야간 N/B 는 앱 자리 A(종이 B)', v33.n122, 'A');
  ok('4명인 날 D/E — 그 자리가 없다고 카드가 알린다', v33.e4);
  eq('102 D/A 는 종이 A 자리, CRN 은 사람대로(김차지)', v33.a102, ['A', '김차지']);
  ok('102 D/CN — 차지는 근무를 DC 로 적는다고 알린다', v33.cn102);
  eq('가능 근무를 정해 둔 병동의 새 간호사 — D·E·N', v33.newCaps, ['D', 'E', 'N']);
  eq('근무표에 NC 가 있는 새 간호사 — NC 는 켠다', v33.newNC, ['D', 'E', 'NC', 'N']);
  eq('처음 시작한 병동의 새 간호사 — 그대로 전부 가능', v33.fresh, [false, null]);
  eq('원칙 4 켜기 → 3 꺼짐, 4 끄기 → 3 돌아옴, 되돌리기 → 4 켠 상태', v33.rules, [false, true, true, false, false, true]);
  eq('파일의 원칙 값 정리 — 빠진 값은 기본, 3·4 둘 다면 3', v33.norm, { keepSameShift: true, keepAcrossShift: true, keepAfterOff: true, bounceAfterOff: false });
  eq("우리 병동 표기로 등록한 'D/E' 는 통째로, 등록 안 한 'N/E' 는 N + 자리 E", [v33.whole, v33.split], ['D/E', 'E']);
  eq("'1호, 2호'·'1~2호'·'1001호' 를 방으로 읽는다", v33.ho, [['1', '2'], ['1', '2'], ['1001']]);
  eq('그날 방 수정은 그 인원수일 때만 — 4명인 날 안 쓰고 카드', v33.rov, [true, 5, true, true]);
  ok('5명으로 돌아오면 그날 방 수정을 다시 쓴다', v33.rovBack);

  // ── 34. 양식의 자리 이름·82 차지·신규 줄 (2026-10-01, 결정 2-45) ─────────────────────────
  // 화면 자리 이름·줄 순서는 종이에서(paperPlan) — 엑셀과 같은 사람 · 82 는 102 처럼 차지가 자리에 묶이지 않고 화면에만 /CRN ·
  // /CRN 은 신규 줄 앞 · 지난 어싸인 직접 입력은 종이의 자리 · 6줄 101 은 화면 인쇄 대신 엑셀 · 대체 줄 · 122 여섯째 자리 이름 ·
  // 교차 검토(PR #73·#74): 손 자리 탓 카드 · DC/CN 걷기 · 다른 사람이 DC 인 날의 D/A(CN) · SU 근무표 · 효력 없는 교체
  step('34 양식 자리 이름·82 차지·신규 줄');
  const v34 = await ev(`const A=window.__app, D1='2026-09-06', D2='2026-09-07', sun=new Date(2026,8,6);
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const base=(id,n)=>{ A.setFormId(id); A.setWard(id); const s=A.store;
      s.order=['김차지','이에이','박비','최씨','정디','한막내'].slice(0,n||5); s.cells={}; s.ovr={}; s.ovrPair={}; s.roomOv={}; s.roomOvCnt={};
      s.presetDay={}; s.seedManual={}; s.unit={}; s.relief={}; s.trainee={}; s.trOv={}; s.evRules=[]; s.daily={}; s.banRooms={}; s.caps={}; s.hidden={};
      s.rules={keepSameShift:true,keepAcrossShift:true,keepAfterOff:true,bounceAfterOff:false};
      s.presets={}; s.presetPlan={}; A.store=s; A.resetSchemes(); return s; };
    const allD=(s,iso)=>{ for(const n of s.order) (s.cells[n]=s.cells[n]||{})[iso]='D'; };
    // 배정표 화면의 한 근무 줄들 — [자리 이름, 그 날 이름 칸]
    const scr=(P,iso)=>{ const o=[]; let cur=null;
      for(const tr of document.querySelectorAll('#wkTable tr')){ const sc=tr.querySelector('td.seccol'); if(sc) cur=sc.textContent.trim();
        const lab=tr.querySelector('td.lab'); if(!lab||cur!==P) continue;
        const nm=tr.querySelector('td.nm[data-iso="'+iso+'"]'); o.push([lab.textContent.trim(),nm?nm.textContent.trim():'']); }
      return o; };
    const week=()=>{ A.wkSunday=new Date(sun); A.show('week'); };
    const card=()=>{ week();
      for(let i=0;i<3;i++){ const f=document.querySelector('#wkWarn.shut .fold')||document.querySelector('#wkWarn .items.clip ~ .more')||document.querySelector('#wkWarn .more');
        if(!f||!/자세히|더 보기/.test(f.textContent)) break; f.click(); }
      return (document.querySelector('#wkWarn')||{}).textContent||''; };
    const xl=async()=>{ const r=await A.buildWeekXlsx(new Date(sun)); return A.sheetCells({...r.tpl,sheetXml:r.xml}); };
    let upN=900;   // savedAt 이 양식 캐시 열쇠다 — 올릴 때마다 달라야 한다
    const upload=async(id,b,xml,extra)=>{ A.store.forms[id]=Object.assign({name:'올린.xlsx',b64:A.bytesToB64(A.packXlsx(b,{'xl/worksheets/sheet1.xml':xml})),savedAt:++upN,ph:false},extra||{});
      await A.loadTemplate(); await sleep(60); A.recompute(); };
    const drop=async id=>{ delete A.store.forms[id]; await A.loadTemplate(); await sleep(60); A.recompute(); };
    return (async()=>{ const out={};
      // ① 82 — 차지가 자리에 묶이지 않는다. 김차지가 쉬어 이에이가 차지가 돼도 이에이는 B 그대로, 화면에만 /CRN
      { const s=base('82',3); s.cells={김차지:{[D1]:'D',[D2]:'OF'},이에이:{[D1]:'D',[D2]:'D'},박비:{[D1]:'OF',[D2]:'D'}};
        await A.loadTemplate(); A.recompute(); week();
        const w=iso=>scr('D',iso).filter(r=>!/SU|중간번/.test(r[0]));
        out.f82=['D','E','N'].map(P=>A.crnFloat(P)); out.s82=[w(D1),w(D2)];
        const r=await A.buildWeekXlsx(new Date(sun)), b=await A.loadBaseTemplate('82');
        out.x82=(r.xml.match(/[/]CRN/g)||[]).length-(b.sheetXml.match(/[/]CRN/g)||[]).length;
        A.show('admin'); A.pickAdmin('seed'); const tr=document.querySelectorAll('#seedTable tr')[1];
        out.seed82=tr?[...tr.children[1].querySelectorAll('button')].map(x=>x.textContent):null; }
      // ② 122 지난 어싸인 직접 입력 — D 여섯째 자리(E)까지
      { const s=base('122',3); allD(s,D1); await A.loadTemplate(); A.recompute(); A.show('admin'); A.pickAdmin('seed');
        const tr=document.querySelectorAll('#seedTable tr')[1]; out.seed122=tr?[...tr.children[1].querySelectorAll('button')].map(x=>x.textContent):null; }
      // ③ 옛 102 양식(D(CRN) 이 맨 아래 줄) — 화면 줄 = 종이 줄, 같은 사람. 방 구성 자리 이름도 종이대로
      { const s=base('102',4); allD(s,D1); const b=await A.loadBaseTemplate('102');
        await upload('102',b,A.setCellStr(b.sheetXml,'C8','D(CRN)')); week();
        const c=await xl();
        out.old102=[scr('D',D1),[5,6,7,8].map(i=>[c['C'+i]||'',c['D'+i]||''])];
        out.old102L=['차지','A','B','C'].map(l=>A.FORM_LBL(l,'D')); out.old102C=A.dayInfo(D1).D.charge;
        // 이름 클릭 창의 자리 바꾸기 단추도 화면 줄 순서 (교차 검토: 앱 안쪽 순서라 D(CRN) 이 맨 위였다)
        A.openPick('최씨',D1,10,10); out.old102Btn=[[...document.querySelectorAll('#pick .swapBtn .lb')].map(x=>x.textContent.trim()),scr('D',D1).map(r=>r[0])]; A.closePick();
        await drop('102'); }
      // ④ 올린 101 양식에서 CN 줄이 둘째 — 차지는 CN 줄, 화면과 엑셀이 같다
      { const s=base('101',5); allD(s,D1); const b=await A.loadBaseTemplate('101'); let x=b.sheetXml;
        const lab={5:'A',6:'CN',7:'B',8:'C',9:'D'}; for(const r in lab) x=A.setCellStr(x,'C'+r,lab[r]);
        await upload('101',b,x); week(); const c=await xl();
        out.cn101=[scr('D',D1),[5,6,7,8,9].map(i=>[c['C'+i]||'',c['E'+i]||''])]; out.cn101C=[A.dayInfo(D1).D.charge,A.crnFloat('D')];
        // 양식 보기의 칸 이름도 종이 이름 (교차 검토: 서식 정의 이름이라 첫 줄이 'A(CN)', 둘째 줄이 'B' 였다)
        { const mk=A.formMapRoles(await A.loadTemplate(),A.formDef()).marks;
          out.cn101V=[[5,6,7,8,9].map(i=>((mk['E'+i]||{}).tag||'').replace(/^D (.+) 이름.*$/,'$1')),scr('D',D1).map(r=>r[0])]; }
        // 첫 줄 이름이 그냥 'A' (CN 표기 없음) — 화면도 'A', 차지는 첫 줄 그대로
        x=b.sheetXml; const lab2={5:'A',6:'B',7:'C',8:'D',9:'E'}; for(const r in lab2) x=A.setCellStr(x,'C'+r,lab2[r]);
        await upload('101',b,x); week(); const d=A.dayInfo(D1).D;
        out.a101=[scr('D',D1).map(r=>r[0]),d.labels['차지']===d.charge,A.crnFloat('D')];
        await drop('101'); }
      // ⑤ D 가 6줄인 올린 101 양식(자리표시자 없음) — 화면 인쇄 틀은 5줄이라 엑셀로
      { base('101',5); const tpl=await A.loadBaseTemplate('101'), F=A.formDefOf('101'); const x=A.fvDraftStart(tpl,F), d=A.seatRowAdd(x,tpl,F,'D',{base:x});
        await upload('101',tpl,d.xml); out.p6=[A.secRows('D'),A.canPrint()]; await drop('101'); out.p5=A.canPrint(); }
      // ⑥ 102 CRN 에 신규가 붙어 있으면 /CRN 은 이름 바로 뒤 (신규 줄 앞) — 엑셀·하루 어싸인표
      { const s=base('102',4); s.order.push('신규일'); allD(s,D1); s.cells['신규일']={[D1]:'/D'}; s.trainee={'신규일':{pre:'김차지'}};
        await A.loadTemplate(); A.recompute(); const c=await xl();
        out.trX=[5,6,7,8].map(i=>c['D'+i]||'').find(v=>/김차지/.test(v))||'';
        A.DAYTPL=null; const dd=await A.buildDayDoc(D1), M=A.dayLayout(dd.doc).main;
        out.trH=M.rows.map(row=>{ const q=M.m.at(row.r,M.shifts.D.nurse); return q?q.text:''; }).find(v=>/김차지/.test(v))||'';
        week(); out.trS=(scr('D',D1).find(r=>/김차지/.test(r[1]))||[])[1]||'';
        // 이름과 차지 표시가 다른 글자 서식(조각)인 칸 — 신규 줄은 칸 맨 끝 (교차 검토: 조각마다 옮겨 /CRN 이 신규 줄 뒤에 붙었다)
        { const b=await A.loadBaseTemplate('102'), m=A.autoMap(b); let x=m.xml; const c0=A.sheetCells({...b,sheetXml:x}); out.trRich=0;
          for(const ref of ['D5','D6','D7','D8']){ const q=String(c0[ref]||'').match(/^([{][{]이름:[^}]+[}][}])([{][{]차지:[^}]*[}][}])$/); if(!q) continue;
            x=A.putCell(x,ref,'<is><r><t>'+q[1]+'</t></r><r><rPr><b/></rPr><t xml:space="preserve">'+q[2]+'</t></r></is>','inlineStr'); out.trRich++; }
          await upload('102',b,x,{ph:true}); const c2=await xl();
          out.trRichX=[5,6,7,8].map(i=>c2['D'+i]||'').find(v=>/김차지/.test(v))||''; await drop('102'); } }
      // ⑦ 대체 줄이 있는 102 — 다섯째 D 가 화면에도 '대체' 줄로
      { const s=base('102',5); allD(s,D1); const b=await A.loadBaseTemplate('102');
        await upload('102',b,A.setCellStr(b.sheetXml,'A9','대체')); week();
        const rows=scr('D',D1); out.sub=[rows.length,rows[rows.length-1]]; out.sub5=A.dayInfo(D1).D.labels['D'];
        await drop('102'); }
      // ⑧ 122 — 화요일에만 D 여섯(월요일은 다섯) — 월~금 방 열에 여섯째 자리 이름이 있다
      { const s=base('122',6); for(const iso of ['2026-09-07','2026-09-08']) allD(s,iso); s.cells['한막내']['2026-09-07']='OF';
        await A.loadTemplate(); A.recompute();
        const t=await A.loadTemplate(), L=A.findLayout122(A.sheetCells(t),A.sheetMerges(t)), r6=L.sections.find(q=>q.P==='D').row+5;
        const c=await xl(); out.e122=[c[A.colName(L.roomColOf[1])+r6]||'',c[A.colName(L.memoCols[2])+r6]||''];
        // 이름 옆 칸은 싸인 칸 — 그 날 방이 방 열과 달라도 비운다. 인쇄도 같이 (2026-10-03 병동 확인)
        //   화요일 차지 방을 그 날만 바꿔(그날 방 수정) 방 열(월요일 기준)과 다르게 만든다 — 예전엔 이런 날 싸인 칸에 방을 적었다
        A.store.roomOv['2026-09-08']={D:{'차지':A.roomsFor('D',5,'A','2026-09-07')}}; A.recompute();
        const c2=await xl(), sg=[]; for(const sec of L.sections) for(let k=0;k<sec.rows;k++) L.memoCols.forEach(mc=>{ const v=c2[A.colName(mc)+(sec.row+k)]; if(v) sg.push(A.colName(mc)+(sec.row+k)+'='+v); });
        const tue=A.dayInfo('2026-09-08').D, mon=A.dayInfo('2026-09-07').D;
        out.sg122=[sg, A.roomsFor('D',tue.cnt,'차지','2026-09-08')!==A.roomsFor('D',mon.cnt,'차지','2026-09-07')];
        await A.buildPrintArea(false);
        out.sg122p=[...document.querySelectorAll('#printArea td.pnm')].map(td=>td.nextElementSibling).filter(td=>td&&td.textContent.trim()).map(td=>td.textContent.trim());
        out.sg122n=document.querySelectorAll('#printArea td.pnm').length; }
      // ⑨ 주지 않을 방 카드 — 칸에 적은 자리가 그 날 없으면(4명인 날 D/E) 손 탓이 아니다 (PR #73 교차 검토)
      { const s=base('101',4); allD(s,D1); s.cells['최씨'][D1]='D/E'; A.recompute();
        const rm=l=>A.roomTokens(A.roomsFor('D',4,l,D1)).map(A.roomFull);
        s.banRooms={'최씨':[...rm('A'),...rm('B'),...rm('C')]}; A.recompute(); const t=card();
        out.ban=[/최씨 — .*주지 않을 방인데 배정됐습니다[.] 모두 피하는 배치가 없습니다/.test(t),/최씨 — [^—]*손으로 옮긴 자리입니다/.test(t)]; }
      // ⑩ PR #74 교차 검토 — DC/CN 인 날 다른 사람에게 DC: 옛 차지의 차지 자리 표기도 걷는다
      { const s=base('101',5); allD(s,D1); s.cells['김차지'][D1]='DC/CN'; A.recompute();
        A.openPick('정디',D1,10,10); A.pickShift('DC'); out.dcCN=[A.dayInfo(D1).D.charge,A.store.cells['김차지'][D1]]; }
      // 다른 사람이 DC 인 날 D/A(CN) — 표시를 따르고 카드가 알린다 (옛 파일의 'D/A' 가 말없이 차지를 가져가지 않게)
      { const s=base('101',5); allD(s,D1); s.cells['김차지'][D1]='DC'; s.cells['박비'][D1]='D/A'; A.recompute();
        out.taken=[A.dayInfo(D1).D.charge,/박비 — 근무표 칸의 'D[/]A': 차지 자리인데 이 날 DC 표시가 다른 사람에게 있어 표시를 따랐습니다/.test(card())];
        A.openPick('정디',D1,10,10); A.pickShift('DC'); out.taken2=[A.dayInfo(D1).D.charge,A.store.cells['박비'][D1]]; }
      // 82 SU 간호사의 DC 는 병동 차지와 상관없다 — 건드리지 않는다
      { const s=base('82',3); s.order.push('바에스유'); s.unit={'바에스유':'SU'}; allD(s,D1); s.cells['바에스유'][D1]='DC'; A.recompute();
        A.openPick('박비',D1,10,10); A.pickShift('DC'); out.su=[A.store.cells['바에스유'][D1],A.dayInfo(D1).D.charge]; }
      // 근무가 바뀌어 효력 없는 교체(정디 OF)가 남의 칸 자리(박비 D/B)를 지우지 않는다
      { const s=base('101',5); allD(s,D1); s.cells['정디'][D1]='OF'; s.cells['박비'][D1]='D/B'; s.ovr={[D1]:{D:{'정디':'A'}}}; A.recompute();
        const L=A.dayInfo(D1).D.labels; out.staleOvr=Object.keys(L).find(l=>L[l]==='박비'); }
      A.setFormId('101'); A.setWard('101'); await A.loadTemplate(); A.show('week');
      return out; })()`, 60000);
  // N 은 종이의 병동 자리가 ward 하나뿐이라 옮겨 앉을 자리가 없다 — 묶어야 맞바꾼 뒤에도 차지가 종이에 보인다 (2026-10-01 교차 검토)
  eq('82 — D·E 는 차지가 자리에 묶이지 않고, 병동 자리가 하나뿐인 N 은 묶는다', v34.f82, [true, true, false]);
  eq('82 9/6 — 김차지 차지, 화면에 /CRN', v34.s82[0], [['A', '김차지 /CRN'], ['B', '이에이']]);
  eq('82 9/7 — 김차지가 쉬어 이에이가 차지여도 B 그대로, 빈 A 에 박비', v34.s82[1], [['A', '박비'], ['B', '이에이 /CRN']]);
  eq('82 엑셀에는 /CRN 을 찍지 않는다 (82 종이 원본대로)', v34.x82, 0);
  eq('82 지난 어싸인 직접 입력 — 종이의 병동 자리 A·B', v34.seed82, ['A', 'B', '없음']);
  eq('122 지난 어싸인 직접 입력 — D 여섯째 자리(E)까지', v34.seed122, ['A', 'B', 'C', 'D', 'E', '없음']);
  eq('옛 102 양식(D(CRN) 맨 아래) — 화면 줄 = 엑셀 줄', v34.old102[0], v34.old102[1]);
  eq('옛 102 양식 — 차지 김차지가 D(CRN) 줄', [v34.old102[0][3], v34.old102C], [['D(CRN)', '김차지'], '김차지']);
  eq('옛 102 양식 — 방 구성 자리 이름도 종이대로', v34.old102L, ['D(CRN)', 'A', 'B', 'C']);
  eq('올린 101 양식(CN 이 둘째 줄) — 화면 줄 = 엑셀 줄', v34.cn101[0], v34.cn101[1]);
  eq('올린 101 양식(CN 이 둘째 줄) — 차지 김차지가 CN 줄, 자리에 묶인다', [v34.cn101[0][1], v34.cn101C], [['CN', '김차지'], ['김차지', false]]);
  eq('올린 101 양식(첫 줄이 그냥 A) — 화면도 A, 차지는 첫 줄', v34.a101, [['A', 'B', 'C', 'D', 'E'], true, false]);
  eq('D 6줄 올린 101 양식 — 화면 여섯 줄, 화면 인쇄 대신 엑셀', v34.p6, [6, false]);
  ok('내장 101 은 화면 인쇄', v34.p5);
  ok('102 엑셀 — /CRN 은 신규 줄 앞', /^김차지 [/]CRN/.test(v34.trX) && /[/] 신규일$/.test(v34.trX), v34.trX);
  ok('102 하루 어싸인표 — /CRN 은 신규 줄 앞', /김차지 [/]CRN/.test(v34.trH) && v34.trH.indexOf('/CRN') < v34.trH.indexOf('/ 신규일'), v34.trH);
  ok('102 화면 — /CRN 은 신규 줄 앞', v34.trS.indexOf('/CRN') >= 0 && v34.trS.indexOf('/CRN') < v34.trS.indexOf('/ 신규일'), v34.trS);
  eq('대체 줄이 있는 102 — 화면 D 다섯째 줄이 대체', v34.sub, [5, ['대체', v34.sub5]]);
  ok('122 — 월~금 방 열에 D 여섯째 자리 이름(E)', /^E/.test(v34.e122[0]), v34.e122[0]);
  eq('122 — 그 자리 방은 방 열과 같아 싸인 칸이 비어 있다', v34.e122[1], '');
  eq('122 — 그 날 방이 방 열과 달라도 엑셀의 이름 옆 싸인 칸은 모두 비어 있다', v34.sg122, [[], true]);
  ok('122 — 인쇄의 이름 옆 싸인 칸도 비어 있다', v34.sg122n > 0 && v34.sg122p.length === 0, JSON.stringify(v34.sg122p.slice(0, 4)));
  eq('주지 않을 방 카드 — 그 날 없는 자리를 적었으면 손 탓이 아니라 "모두 피하는 배치가 없습니다"', v34.ban, [true, false]);
  eq('DC/CN 인 날 정디에게 DC — 정디가 차지, 김차지는 D(차지 자리 표기도 걷음)', v34.dcCN, ['정디', 'D']);
  eq('다른 사람이 DC 인 날 D/A(CN) — 표시대로 김차지가 차지, 카드', v34.taken, ['김차지', true]);
  eq('그 날 정디에게 DC — 정디가 차지, 박비의 차지 자리 표기는 걷는다', v34.taken2, ['정디', 'D']);
  eq('82 — 병동 간호사에게 DC 를 줘도 SU 간호사의 DC 는 그대로', v34.su, ['DC', '박비']);
  eq('효력 없는 교체(정디 OF)는 박비의 D/B 를 지우지 않는다', v34.staleOvr, 'A');
  eq('옛 102 양식 — 이름 클릭 창의 자리 단추 = 화면 줄 순서', v34.old102Btn[0], v34.old102Btn[1]);
  eq('올린 101 양식(CN 이 둘째 줄) — 양식 보기 칸 이름 = 화면 줄 이름', v34.cn101V[0], v34.cn101V[1]);
  ok('102 조각 서식 이름 칸 — /CRN 은 신규 줄 앞', v34.trRich === 4 && /^김차지 [/]CRN\n[/] 신규일$/.test(v34.trRichX), JSON.stringify([v34.trRich, v34.trRichX]));

  // ── 35. 옆 파일 자동 열림 → 저장 연결 (2026-10-03 사용자 제보) ─────────────────────
  // 같은 폴더의 assign-data.js 를 읽고 [저장 연결]로 파일을 고르면 연결됐는데도 알약이 빨강 '저장 연결 안 됨'이었다 —
  // 자동으로 읽을 때 적어 둔 저장 문장이 연결 뒤에도 남았다. 실제 파일 창은 못 띄우므로 같은 모양의 가짜 핸들을 쓴다.
  const v35 = await ev(`return (async()=>{ const A=window.__app; const keepStore=JSON.parse(JSON.stringify(A.store));
    const el=document.querySelector('#fileInfo'), pill=()=>[el.textContent.trim(), el.className];
    const toastTxt=()=>document.querySelector('#toast').textContent;
    const wait=ms=>new Promise(r=>setTimeout(r,ms));
    const txt0='window.__ASSIGN_DATA='+JSON.stringify({...keepStore,rev:7})+';';
    const mk=(name,body)=>{ const h={name,kind:'file',written:null,
      queryPermission:async()=>'prompt', requestPermission:async()=>'granted',
      getFile:async()=>new File([h.written||body||''],name),
      createWritable:async()=>({write:async d=>{ h.written=d; }, close:async()=>{}})}; return h; };
    const side=()=>{ fileHandle=null; clearTimeout(saveT); A.dirty=false; window.__reattachTried=false; window.__autoReadWarned=false; window.__reattachDenied=false;
      openSidecar({name:'assign-data.js', data:{...JSON.parse(JSON.stringify(keepStore)),rev:7}}); };
    const unload=()=>{ const e=new Event('beforeunload',{cancelable:true}); window.dispatchEvent(e); return e.defaultPrevented; };
    const realIdb=idbGet, realProbe=probeSidecar, keepOpen=window.showOpenFilePicker, keepSave=window.showSaveFilePicker;
    window.idbGet=async k=> k==='handle'?null:realIdb(k);          // 기억된 핸들 없음 — 처음 쓰는 PC·사이트 데이터를 지우는 PC
    const out={};
    side(); out.처음=pill(); out.처음닫기=unload();
    // 고치지 않고 바로 [저장 연결] → 파일 창에서 같은 파일
    const h1=mk('assign-data.js',txt0); window.showOpenFilePicker=async()=>[h1];
    await connectSave(); await wait(300); out.연결=pill(); out.연결닫기=unload();
    // 읽기만 하는 중에 고침 → 화면에만 있다는 것을 알약과 닫기 확인으로 알린다 → [저장 연결]이면 그대로 저장
    side(); touch(); await wait(1100); out.고친뒤=pill(); out.고친뒤닫기=unload(); out.고친뒤알림=toastTxt();
    const h2=mk('assign-data.js',txt0); window.showOpenFilePicker=async()=>[h2];
    await connectSave(); await wait(300); out.고친뒤연결=[pill()[1], !!h2.written, unload()];
    // 새 파일 — HTML 옆인지(내용 대조)에 따라 안내가 다르다
    const h3=mk('assign-data.js'); window.showSaveFilePicker=async()=>h3;
    window.probeSidecar=async n=>({exists:true,data:h3.written?JSON.parse(h3.written.slice(h3.written.indexOf('=')+1,h3.written.lastIndexOf(';'))):null});
    await newDataFile(); out.옆새파일=toastTxt();
    const h4=mk('assign-data.js'); window.showSaveFilePicker=async()=>h4; window.probeSidecar=async()=>({exists:false,data:null});
    await newDataFile(); out.딴곳새파일=toastTxt();
    const h5=mk('근무.js'); window.showSaveFilePicker=async()=>h5;
    await newDataFile(); out.딴곳딴이름=toastTxt();
    window.idbGet=realIdb; window.probeSidecar=realProbe; window.showOpenFilePicker=keepOpen; window.showSaveFilePicker=keepSave;
    fileHandle=null; window.__autoRead=false; window.__autoEdits=false; A.store=keepStore; A.memoryMode(); A.saveMsg('');
    return out; })();`);
  eq('옆 파일을 읽은 처음 — 노랑 읽기 전용, 닫아도 묻지 않는다', [v35.처음, v35.처음닫기], [['읽기 전용', 'warn'], false]);
  ok('[저장 연결]로 파일을 고르면 알약이 저장됨 — 옛 \'저장 연결 안 됨\'이 남지 않는다',
    /^저장됨/.test(v35.연결[0]) && v35.연결[1] === 'ok' && !v35.연결닫기, JSON.stringify(v35.연결));
  eq('읽기만 하는 중에 고치면 빨강 \'고친 것 저장 안 됨\' + 닫을 때 확인', [v35.고친뒤, v35.고친뒤닫기], [['고친 것 저장 안 됨', 'off'], true]);
  ok('그 알림은 \'읽기 전용\'이라 하지 않고 [저장 연결]을 가리킨다', !/읽기 전용/.test(v35.고친뒤알림) && /저장 연결/.test(v35.고친뒤알림), v35.고친뒤알림);
  eq('고친 뒤 [저장 연결] — 고친 것이 파일에 써지고 닫기 확인은 풀린다', v35.고친뒤연결, ['ok', true, false]);
  ok('HTML 옆에 만든 새 파일 — 다음부터 바로 뜬다', /다음부터는 켜면 바로/.test(v35.옆새파일), v35.옆새파일);
  ok('다른 폴더에 만든 assign-data.js — 바로 뜬다고 하지 않고 HTML 옆으로 옮기라고', !/다음부터는 켜면 바로/.test(v35.딴곳새파일) && /assign\.html 파일이 있는 폴더로 옮겨/.test(v35.딴곳새파일) && !/이름은/.test(v35.딴곳새파일), v35.딴곳새파일);
  ok('다른 폴더·다른 이름 — 옮기기에 이름까지', /폴더로 옮겨/.test(v35.딴곳딴이름) && /이름은 assign-data\.js/.test(v35.딴곳딴이름), v35.딴곳딴이름);

  // ── 36. 파일 창이 어디서 열리나 (2026-10-03 사용자: "문서에서 시작한다 — 같은 폴더부터") ─────────────────────
  // 브라우저는 파일 창을 경로로 열지 못한다: 기억한 파일의 폴더 > HTML 이 든 바탕 화면·문서·다운로드 > 브라우저 기본.
  // 윈도 경로면 HTML 옆 경로를 복사해 두고 '파일 이름 칸에 Ctrl+V' 를 알린다. 실제 파일 창은 못 띄우므로 옵션을 받아 본다.
  const v36 = await ev(`return (async()=>{ const A=window.__app; const keepStore=JSON.parse(JSON.stringify(A.store));
    const wait=ms=>new Promise(r=>setTimeout(r,ms)), toastTxt=()=>document.querySelector('#toast').textContent;
    const out={};
    out.위치=['file:///C:/Users/kim/Desktop/%EC%96%B4%EC%8B%B8%EC%9D%B8/assign.html',
      'file:///C:/Users/kim/OneDrive/%EB%B0%94%ED%83%95%20%ED%99%94%EB%A9%B4/assign.html',
      'file:///C:/Users/kim/Documents/assign.html','file:///C:/Users/kim/Downloads/x/assign.html',
      'file:///C:/Users/Desktop/assign.html','file:///D:/%EB%B3%91%EB%8F%99/assign.html','file://srv/share/assign.html'].map(u=>wellKnownOf(u));
    const realIdb=idbGet, realWK=wellKnownOf, realDir=htmlDirPath, keepOpen=window.showOpenFilePicker;
    const rem={name:'assign-data.js',kind:'file'};
    let idbH=rem; window.idbGet=async k=> k==='handle'?idbH:realIdb(k);
    let wk=null; window.wellKnownOf=()=>wk;
    const pick=o=>({id:o.id||null, start:o.startIn===rem?'기억한 파일':(o.startIn||null), types:!!o.types});
    window.__reattachOther=false; out.기억=pick(await pickerOpts({types:[1]}));
    wk='desktop'; window.__reattachOther=true; out.딴파일=pick(await pickerOpts({types:[1]}));
    idbH=null; wk=null; window.__reattachOther=false; out.없음=pick(await pickerOpts({}));
    // 브라우저가 startIn 을 못 받으면 그것만 빼고 한 번 더 — 창을 닫은 것(AbortError)은 그대로
    idbH=rem; const calls=[];
    out.재시도=await pickWith(async o=>{ calls.push(!!o.startIn); if(o.startIn) throw new TypeError('x'); return 'ok'; },{});
    out.재시도호출=calls;
    try{ await pickWith(async()=>{ throw new DOMException('닫음','AbortError'); },{}); out.닫음='안 던짐'; }catch(e){ out.닫음=e.name; }
    // 경로 복사 — 윈도 드라이브·UNC 는 복사, 맥·리눅스 경로는 안 함
    let clip=null; Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{ clip=t; }}});
    window.htmlDirPath=()=>realDir('file:///D:/%EB%B3%91%EB%8F%99/assign.html'); out.복사=[await copyPathHint('assign-data.js'), clip];
    clip=null; window.htmlDirPath=()=>realDir('file://srv/share/x/assign.html'); out.복사UNC=[await copyPathHint('assign-data.js'), clip];
    clip=null; window.htmlDirPath=()=>realDir('file:///Users/kim/x/assign.html'); out.복사맥=[await copyPathHint('assign-data.js'), clip];
    // 기억한 핸들이 다른 폴더의 같은 이름 파일 — 이어 쓰지 않고, 시작 폴더로도 안 쓰고, 파일 창에서 고르게 한다
    const mk=(rev,saved)=>{ const h={name:'assign-data.js',kind:'file',asks:0,written:null,
      queryPermission:async()=>'prompt', requestPermission:async()=>{ h.asks++; return 'granted'; },
      getFile:async()=>new File([h.written||('window.__ASSIGN_DATA='+JSON.stringify({...keepStore,rev,saved})+';')],'assign-data.js'),
      createWritable:async()=>({write:async d=>{ h.written=d; }, close:async()=>{}})}; return h; };
    const side=()=>{ fileHandle=null; clearTimeout(saveT); A.dirty=false; window.__reattachTried=false; window.__autoReadWarned=false; window.__reattachDenied=false;
      openSidecar({name:'assign-data.js', data:{...JSON.parse(JSON.stringify(keepStore)),rev:7,saved:'2026-10-03T01:00:00Z'}}); };
    window.htmlDirPath=realDir;
    side(); const other=mk(3,'2026-09-01T01:00:00Z'); idbH=other;
    out.딴곳잇기=[await reattachHandle(other), !!fileHandle, !!window.__reattachOther, other.written];
    const here=mk(7,'2026-10-03T01:00:00Z'); let seen=null;
    window.showOpenFilePicker=async o=>{ seen=o; return [here]; };
    window.htmlDirPath=()=>realDir('file:///D:/%EB%B3%91%EB%8F%99/assign.html'); clip=null;
    const asks0=other.asks; await connectSave(); await wait(300); out.연결알림=toastTxt();
    out.딴곳연결=[other.asks-asks0, seen&&seen.startIn===other, seen&&seen.id, fileHandle===here, clip, !!window.__reattachOther];
    side(); idbH=mk(7,'2026-10-03T01:00:00Z');
    out.같은파일잇기=[await reattachHandle(idbH), fileHandle===idbH];
    // '허용' 창 뒤라 이번 클릭으로 파일 창이 안 열릴 때 — 한 번 더 누르라고
    side(); idbH=null; window.htmlDirPath=realDir;
    window.showOpenFilePicker=async()=>{ throw new DOMException('Must be handling a user gesture','SecurityError'); };
    await connectSave(); out.몸짓=toastTxt();
    delete navigator.clipboard;
    window.idbGet=realIdb; window.wellKnownOf=realWK; window.htmlDirPath=realDir; window.showOpenFilePicker=keepOpen;
    fileHandle=null; window.__autoRead=false; window.__autoEdits=false; window.__reattachOther=false; A.store=keepStore; A.memoryMode(); A.saveMsg('');
    return out; })();`);
  eq('HTML 위치 → 파일 창 시작 폴더 (바탕 화면·OneDrive 바탕 화면·문서·다운로드, 사용자 이름이 Desktop 이어도·다른 드라이브·공유 폴더는 없음)',
    v36.위치, ['desktop', 'desktop', 'documents', 'downloads', null, null, null]);
  eq('기억한 데이터 파일이 있으면 그 파일의 폴더에서, 같은 id 로', v36.기억, { id: 'assign-data', start: '기억한 파일', types: true });
  eq('기억한 파일이 다른 폴더 것으로 판명나면 HTML 위치 폴더에서', v36.딴파일, { id: 'assign-data', start: 'desktop', types: true });
  eq('아무것도 모르면 시작 폴더 없이 id 만 (브라우저가 이 창에서 지난번 연 폴더)', v36.없음, { id: 'assign-data', start: null, types: false });
  eq('시작 폴더를 못 받으면 빼고 한 번 더', [v36.재시도, v36.재시도호출], ['ok', [true, false]]);
  eq('파일 창을 닫은 것은 다시 열지 않는다', v36.닫음, 'AbortError');
  eq('윈도 드라이브 경로는 HTML 옆 파일 경로를 복사', v36.복사, [true, 'D:\\병동\\assign-data.js']);
  eq('공유 폴더(UNC) 경로도 복사', v36.복사UNC, [true, '\\\\srv\\share\\x\\assign-data.js']);
  eq('맥 경로는 복사하지 않는다', v36.복사맥, [false, null]);
  eq('기억한 핸들이 내용이 다른 같은 이름 파일이면 잇지 않는다 (쓰지도 않는다)', v36.딴곳잇기, [false, false, true, null]);
  eq('그 뒤 [저장 연결] — 허용 창 다시 안 묻고, 그 폴더에서 열지 않고, 경로를 복사해 고른 파일로 연결',
    v36.딴곳연결, [0, false, 'assign-data', true, 'D:\\병동\\assign-data.js', false]);
  ok('그때 알림은 연결 완료 (경로 복사 안내는 파일 창 앞에)', /저장 연결 완료/.test(v36.연결알림), v36.연결알림);
  eq('기억한 핸들이 방금 읽은 그 파일이면 허용 한 번으로 잇는다', v36.같은파일잇기, [true, true]);
  ok('파일 창이 몸짓 오류로 안 열리면 한 번 더 누르라고 (영어 오류 문장 아님)', /한 번 더 눌러/.test(v36.몸짓) && !/gesture/.test(v36.몸짓), v36.몸짓);

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
