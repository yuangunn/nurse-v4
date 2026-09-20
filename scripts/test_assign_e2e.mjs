/* assign.html 끝에서 끝까지 — 진짜 화면만 만진다.
 *
 * 다른 검사들은 window.__app 의 함수를 직접 부른다. 그건 로직은 지켜 주지만
 * "버튼이 실제로 눌리는가"는 못 본다. 여기서는 좌표로 마우스를 눌러 클릭하고,
 * 진짜 paste 이벤트를 쏘고, 브라우저가 내려받은 xlsx 파일을 열어 확인한다.
 *
 *   처음 켜기 → 마법사 7단계(병동·방구성·필요인원·근무표 붙여넣기·표기·가능근무)
 *   → 배정표가 뜨는지 → 휴무자 투입 → 엑셀로 내보내기 → 받은 파일 열어 보기
 *
 * 저장만 memoryMode 를 쓴다 — file:// 헤드리스에서는 파일 선택창을 띄울 수 없다.
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (typeof WebSocket === 'undefined') {
  console.log('SKIP assign e2e — 전역 WebSocket 이 없습니다 (Node 22+ 필요)');
  process.exit(0);
}
const WORK = mkdtempSync(join(tmpdir(), 'assign-e2e-'));
const DOWN = join(WORK, 'down');
copyFileSync(resolve(ROOT, 'standalone/assign.html'), join(WORK, 'assign.html'));

const CHROME = process.env.CHROME ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9400 + (process.pid % 90);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`,
  '--disable-gpu', '--no-first-run', '--no-sandbox', '--allow-file-access-from-files',
  '--window-size=1920,1080', `--user-data-dir=${join(WORK, 'profile')}`,
  'file://' + join(WORK, 'assign.html')], { stdio: 'ignore' });
chrome.on('error', () => { console.log('SKIP assign e2e — 크롬을 찾지 못했습니다'); process.exit(0); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, seq = 0, STEP = '시작';
const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => {
  const id = ++seq; pend.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method: m, params: p }));
});
async function ev(expr, ms = 20000) {
  const r = await Promise.race([
    send('Runtime.evaluate', { expression: `(()=>{${expr}})()`, returnByValue: true, awaitPromise: true }),
    sleep(ms).then(() => { throw new Error(`[${STEP}] 응답 없음 ${ms}ms`); })]);
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception || {};
    throw new Error(`[${STEP}] ${d.description || d.value}`);
  }
  return r.result.value;
}

let pass = 0; const fails = [];
const ok = (what, cond, got) => {
  if (cond) { pass++; console.log(`  ok   ${what}`); }
  else { fails.push(what); console.log(`  FAIL ${what}\n       받음 ${got}`); }
};
const eq = (what, got, want) => ok(what, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got) + ' / 기대 ' + JSON.stringify(want));
const step = s => { STEP = s; console.log(`\n── ${s}`); };

/* 글자로 보이는 요소를 찾아 그 한가운데를 진짜로 누른다 */
async function tap(text, scope = 'body') {
  const box = await ev(`
    // position:fixed 안의 요소는 offsetParent 가 null 이라 그걸로 판정하면 안 된다.
    const vis=e=>{const r=e.getBoundingClientRect(), c=getComputedStyle(e);
      return r.width>0&&r.height>0&&c.visibility!=='hidden'&&c.opacity!=='0';};
    const want=${JSON.stringify(text)};
    const all=[...document.querySelectorAll(${JSON.stringify(scope)}+' button, '+${JSON.stringify(scope)}+' .act, '+${JSON.stringify(scope)}+' a')];
    const hit=all.filter(e=>vis(e)&&(e.textContent||'').replace(/\\s+/g,' ').trim().includes(want));
    if(!hit.length) return null;
    const el=hit[hit.length-1];
    el.scrollIntoView({block:'center'});        // 화면 밖이면 좌표 클릭이 허공을 친다
    const r=el.getBoundingClientRect();
    const x=r.x+r.width/2, y=r.y+r.height/2;
    const top=document.elementFromPoint(x,y);   // 무언가 덮고 있으면 여기서 드러난다
    return {x,y,t:(el.textContent||'').trim().slice(0,20),
      막힘: top&&top!==el&&!el.contains(top) ? (top.id||top.className||top.tagName) : null};`);
  if (!box) throw new Error(`[${STEP}] '${text}' 단추를 화면에서 찾지 못했습니다 — 보이는 것: ` +
    JSON.stringify(await ev(`const vis=e=>{const r=e.getBoundingClientRect(),c=getComputedStyle(e);
      return r.width>0&&r.height>0&&c.visibility!=='hidden';};
      return [...document.querySelectorAll('button,.act')].filter(vis)
        .map(b=>(b.textContent||'').replace(/\s+/g,' ').trim().slice(0,20));`)));
  if (box.막힘) throw new Error(`[${STEP}] '${text}' 를 '${box.막힘}' 가 덮고 있습니다`);
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  await sleep(160);
  return box.t;
}

/* 엑셀에서 긁어 온 것처럼 탭으로 나뉜 근무표 — 16명 4주 블록 근무 */
function schedule() {
  const NAMES = ['가선임','나선임','다선임','라간호','마간호','바간호','사간호','아간호',
                 '자간호','차간호','카간호','타간호','파간호','하간호','거간호','너간호'];
  const SLOT = i => i < 5 ? 'D' : i < 10 ? 'E' : i < 13 ? 'N' : 'OF';
  const head = ['이름'];
  for (let d = 1; d <= 30; d++) head.push(`9/${d}`);
  const rows = [head];
  NAMES.forEach((n, i) => {
    const r = [n];
    for (let d = 1; d <= 30; d++) r.push(SLOT((i + d) % 16));
    rows.push(r);
  });
  return rows.map(r => r.join('\t')).join('\n');
}

try {
  // CDP 붙기
  let tgt = null;
  for (let i = 0; i < 80 && !tgt; i++) {
    try { tgt = JSON.parse(execSync(`curl -s http://127.0.0.1:${PORT}/json`).toString())
      .find(t => t.type === 'page' && t.url.includes('assign')); } catch {}
    if (!tgt) await sleep(250);
  }
  if (!tgt) throw new Error('크롬에 붙지 못했습니다');
  ws = new WebSocket(tgt.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r));
  ws.addEventListener('message', m => {
    const d = JSON.parse(m.data); const p = pend.get(d.id);
    if (p) { pend.delete(d.id); d.error ? p.rej(new Error(JSON.stringify(d.error))) : p.res(d.result); }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWN });

  for (let i = 0; i < 60; i++) { if (await ev('return !!(window.__app&&window.__app.startWizard)')) break; await sleep(250); }
  await ev(`window.confirm=()=>true; window.alert=()=>{}; window.__errs=[];
    window.addEventListener('error',e=>window.__errs.push(String(e.message))); return 1`);
  await ev('window.__app.memoryMode(); return 1');

  step('1 처음 켠 화면');
  // 환영 카드는 켜고 0.7초 뒤에 뜬다 — 사람은 이걸 먼저 보고 닫는다.
  for (let i = 0; i < 20 && !(await ev(`return document.querySelector('#intro').classList.contains('on')`)); i++)
    await sleep(150);
  ok('처음 켜면 환영 카드가 뜬다', await ev(`return document.querySelector('#intro').classList.contains('on')`), '안 뜸');
  await tap('시작하기');
  ok('환영 카드가 닫혔다', !(await ev(`return document.querySelector('#intro').classList.contains('on')`)), '열린 채');
  ok('시작 안내가 떠 있다', await ev(`const e=document.querySelector('#onboard');
    return !!e&&getComputedStyle(e).display!=='none';`), '안 보임');
  await tap('남은 준비 보기');          // 시작 안내 카드는 접혀 있다
  await tap('처음 설정 다시 하기');
  ok('마법사가 열렸다', await ev(`return document.querySelector('#wiz').classList.contains('on')`), '안 열림');

  step('2 병동 고르기');
  await ev(`const s=[...document.querySelectorAll('#wizBody select')].find(x=>[...x.options].some(o=>o.value==='122'));
    if(!s) throw new Error('병동 고르는 칸이 없습니다');
    s.value='122'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1`);
  await sleep(300);
  eq('병실 14개가 자동으로 찼다', await ev('return window.__app.store.rooms.length'), 14);
  await tap('다음', '#wizFoot');

  step('3 방 구성 · 4 필요 인원');
  await tap('다음', '#wizFoot');
  await tap('다음', '#wizFoot');
  eq('근무표 붙여넣기 단계', await ev(`return document.querySelector('#wizTitle').textContent`), '근무표를 넣어 주세요');

  step('5 근무표 붙여넣기');
  await tap('근무표', '#wizBody').catch(() => tap('넣기', '#wizBody'));
  await sleep(250);
  await ev(`const dt=new DataTransfer(); dt.setData('text/plain', ${JSON.stringify(schedule())});
    document.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true})); return 1`);
  await sleep(400);
  ok('미리보기에 사람이 잡혔다', await ev(`return (document.querySelector('#pvMap')||{}).textContent?1:0`) ||
     await ev(`return document.querySelectorAll('#scrPaste table tr').length>2`), '미리보기 없음');
  await tap('맞아요, 저장');
  await sleep(500);
  ok('간호사 16명이 들어왔다', (await ev('return window.__app.store.order.length')) === 16,
     await ev('return window.__app.store.order.length'));

  step('6 표기 · 7 가능 근무');
  if (await ev(`return document.querySelector('#wiz').classList.contains('on')?
      document.querySelector('#wizTitle').textContent:''`) === '모르는 표기가 있나요?')
    await tap('다음', '#wizFoot');
  // 가능 근무는 기본이 전부 켜짐(capsOf 가 미설정이면 ALL_CAPS)이라 이 단계는 이미 통과다.
  // 대신 칩이 진짜 눌리는지를 본다 — 하나 껐다가 다시 켠다.
  const chip = async () => await ev(`const A=window.__app; const who=A.store.order[0];
    const el=[...document.querySelectorAll('#wizBody .capChip')].find(x=>
      (x.getAttribute('onclick')||'').includes("'"+who+"','DC'"));
    if(!el) return null;
    el.scrollIntoView({block:'center'});
    const r=el.getBoundingClientRect();
    const x=r.x+r.width/2, y=r.y+r.height/2;
    const top=document.elementFromPoint(x,y);
    return {x,y, on:el.classList.contains('on'), cls:el.className,
      막힘: top&&top!==el&&!el.contains(top) ? (top.id||top.className||top.tagName) : null};`);
  const before = await chip();
  ok('차지 칩이 기본으로 켜져 있다', before && before.on, JSON.stringify(before));
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: before.x, y: before.y, button: 'left', clickCount: 1 });
  await sleep(150);
  const afterOff = await ev(`const A=window.__app; const who=A.store.order[0];
    const el=[...document.querySelectorAll('#wizBody .capChip')].find(x=>
      (x.getAttribute('onclick')||'').includes("'"+who+"','DC'"));
    return {저장:(A.store.caps[who]||[]).includes('DC'), 화면:el?el.classList.contains('on'):null};`);
  ok('칩을 누르면 저장에서 빠진다', afterOff.저장 === false, JSON.stringify(afterOff));
  ok('칩을 누르면 화면에서도 꺼진다', afterOff.화면 === false, JSON.stringify(afterOff));
  const back = await chip();
  for (const type of ['mousePressed', 'mouseReleased'])
    await send('Input.dispatchMouseEvent', { type, x: back.x, y: back.y, button: 'left', clickCount: 1 });
  await sleep(150);
  ok('다시 누르면 켜진다', (await chip()).on === true, JSON.stringify(await chip()));
  // 마법사는 조건이 찼으면 '다음 ▶', 안 찼으면 '건너뛰고 다음 ▶' 으로 스스로 말한다.
  eq('마법사가 이 단계를 찼다고 본다',
    await ev(`const b=[...document.querySelectorAll('#wizFoot button')].pop();
      return b?b.textContent.trim():'';`), '다음 ▶');
  await tap('다음', '#wizFoot');
  eq('마지막 단계', await ev(`return document.querySelector('#wizTitle').textContent`), '모두 끝났습니다');
  await tap('배정표 보기', '#wizFoot');
  await sleep(400);

  step('8 배정표 화면');
  ok('마법사가 닫혔다', !(await ev(`return document.querySelector('#wiz').classList.contains('on')`)), '열린 채');
  const wk = await ev(`const t=document.querySelector('#wkTable');
    return {줄:t?t.querySelectorAll('tr').length:0, 이름:t?t.querySelectorAll('td.nm').length:0};`);
  ok('배정표에 줄이 그려졌다', wk.줄 > 10, JSON.stringify(wk));
  ok('배정표에 이름이 찼다', wk.이름 > 40, JSON.stringify(wk));

  step('9 엑셀로 내보내기');
  await tap('엑셀');
  for (let i = 0; i < 40 && !(existsSync(DOWN) && readdirSync(DOWN).some(f => f.endsWith('.xlsx'))); i++) await sleep(250);
  const got = existsSync(DOWN) ? readdirSync(DOWN).filter(f => f.endsWith('.xlsx')) : [];
  ok('xlsx 파일이 실제로 내려받아졌다', got.length === 1, JSON.stringify(readdirSync(DOWN || '.')));
  if (got.length) {
    const buf = readFileSync(join(DOWN, got[0]));
    ok('xlsx(zip) 로 열린다', buf[0] === 0x50 && buf[1] === 0x4b, buf.slice(0, 4).toString('hex'));
    ok('크기가 양식만큼 된다 (100KB+)', buf.length > 100000, String(buf.length));
    console.log(`  · 받은 파일: ${got[0]} (${(buf.length / 1024).toFixed(0)}KB)`);
  }

  step('10 받은 파일 열어 보기');
  if (got.length) {
    const file = join(DOWN, got[0]);
    // 테두리 검사기를 그대로 다시 쓴다 — 양식이 아니라 '내보낸 결과물'에 구멍이 없는지
    const borders = execSync(`python3 ${JSON.stringify(resolve(ROOT, 'scripts/check_form_borders.py'))} ${JSON.stringify(file)}`,
      { encoding: 'utf8' });
    ok('내보낸 배정표에 테두리 구멍이 없다', /구멍 없음/.test(borders), borders.trim().split('\n').pop());

    // 받은 파일을 열어 내용을 본다 (-c 는 줄바꿈이 깨져서 파일로 돌린다)
    const peek = join(WORK, 'peek.py');
    writeFileSync(peek, [
      'import sys, json',
      `sys.path.insert(0, ${JSON.stringify(resolve(ROOT, 'scripts'))})`,
      'from check_form_borders import load, layout, colname',
      'D = load(sys.argv[1])',
      'blocks, rows = layout(D)',
      'names = []',
      'for r in rows:',
      '    for a, b in blocks:',
      '        for c in range(a, b + 1):',
      "            t = (D['text'].get(colname(c) + str(r)) or '').strip()",
      "            if t and not t.replace('.', '').isdigit(): names.append(t)",
      'wd = min(rows) - 2',            // 요일 줄 바로 아래가 날짜 줄
      "dates = [D['text'].get(colname(a) + str(wd)) for a, b in blocks]",
      "print(json.dumps({'이름': sorted(set(names)), '날짜칸': len([d for d in dates if d])}, ensure_ascii=False))",
    ].join('\n'));
    const cells = JSON.parse(execSync(`python3 ${JSON.stringify(peek)} ${JSON.stringify(file)}`, { encoding: 'utf8' }));
    eq('요일 7칸에 날짜가 다 찼다', cells.날짜칸, 7);
    const screen = await ev(`return [...new Set([...document.querySelectorAll('#wkTable td.nm')]
      .map(e=>(e.childNodes[0]||{}).textContent||'').map(t=>t.trim()).filter(Boolean))].sort();`);
    ok('파일 속 이름이 화면과 같다',
      JSON.stringify(cells.이름.filter(n => screen.includes(n)).length) === JSON.stringify(screen.length) &&
      screen.length > 8, `파일 ${cells.이름.length}명 / 화면 ${screen.length}명`);
  }

  step('11 화면에서 난 오류');
  eq('콘솔 오류 없음', await ev('return window.__errs.slice(0,5)'), []);

} catch (e) {
  fails.push(String(e.message));
  console.log('\n오류: ' + e.message);
} finally {
  try { chrome.kill(); } catch {}
}
console.log(`\nassign e2e: ${pass}건 통과${fails.length ? ` · ${fails.length}건 실패` : ''}`);
process.exit(fails.length ? 1 : 0);
