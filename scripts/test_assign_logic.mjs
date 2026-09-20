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
                num:document.querySelector('#wizNum').textContent}); }
    A.closeWizard(); return out;`);
  eq('마법사 단계 순서', wiz.map(w => w.id),
    ['ward', 'scheme', 'req', 'paste', 'codes', 'caps', 'done']);
  ok('단계마다 본문이 그려진다 (패널 id 가 어긋나면 빈다)',
    wiz.every(w => w.body > 200), JSON.stringify(wiz.map(w => [w.id, w.body])));
  eq('진행도 표시', wiz[2].num, '3 / 7 단계');

  // 붙여넣기 단계만 전체 화면을 빌려 쓰고, 확정하면 마법사로 돌아온다
  const trip = await ev(`const A=window.__app; A.startWizard(3); A.wizPaste();
    const away=!document.querySelector('#wiz').classList.contains('on')
      && document.querySelector('#scrPaste').style.display!=='none';
    A.ingestGrid([['이름','9/1','9/2'],['홍길동','D','E'],['김영숙','E','N']]);
    A.confirmPaste();
    const back=document.querySelector('#wiz').classList.contains('on');
    const at=document.querySelector('#wizNum').textContent;
    A.closeWizard();
    return {away, back, at};`);
  ok('붙여넣기는 전체 화면으로 넘어간다', trip.away, JSON.stringify(trip));
  ok('확정하면 마법사 다음 단계로 돌아온다', trip.back && trip.at === '5 / 7 단계', JSON.stringify(trip));

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

  // ── 11. 요일별 필요 인원을 근무표에서 역산 ────────────────────────────
  // 기본값이 101 기준이라 다른 병동은 배정표에서 '인원이 필요 인원과 다릅니다' 를
  // 매주 본다. 고칠 곳으로 데려가는 길이 없었다.
  step('11 필요 인원 역산');
  const fit = await ev(`const A=window.__app; const s=A.store;
    s.order=['가','나','다','라','마','바'];
    s.cells={}; s.order.forEach(n=>s.cells[n]={});
    // 2026-09-06(일) ~ 09-12(토) — 일요일만 D2, 나머지 요일은 D3 로 넣는다
    const days=['2026-09-06','2026-09-07','2026-09-08','2026-09-09','2026-09-10','2026-09-11','2026-09-12'];
    days.forEach((iso,i)=>{ const nD=i===0?2:3;
      s.order.forEach((n,k)=>{ s.cells[n][iso] = k<nD?'D' : k<nD+2?'E' : k<nD+3?'N':'OF'; }); });
    A.store=s; A.recompute();
    const sug=A.reqFromSchedule();
    return {일:sug.sun, 월:sug.mon, 토:sug.sat};`);
  eq('일요일은 근무표대로 D 2명', fit.일.D, 2);
  eq('월요일은 D 3명', fit.월.D, 3);
  eq('E·N 도 센다', [fit.월.E, fit.월.N], [2, 1]);

  const fitted = await ev(`const A=window.__app;
    const before=JSON.parse(JSON.stringify(A.store.req));
    A.fitReqToSchedule();
    return {전:before.sun.D, 후:A.store.req.sun.D, 월:A.store.req.mon.D};`);
  ok('맞추면 store.req 가 바뀐다', fitted.후 === 2 && fitted.월 === 3, JSON.stringify(fitted));

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
  eq('122 자리 수 5·5·3 · 방 칸 있음', [perForm['122'].rows, perForm['122'].noRooms], [[5, 5, 3], false]);
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
