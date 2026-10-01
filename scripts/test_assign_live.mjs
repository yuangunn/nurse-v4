// 배정표 실시간 수정 검사 — node scripts/test_assign_live.mjs [--seed N 또는 1,2,3] [--ops N] [--only 키]
//
// 102 의 차지 자리 오류는 코드를 읽어서가 아니라 **배정표에서 사람을 실시간으로 바꿔 보다가** 드러났다
// (차지를 바꿔도 자리가 그대로여야 하는데 모두 한 칸씩 밀렸다). 그래서 이 검사는 함수를 직접 부르지 않고
// 사람이 하는 대로 배정표 화면의 이름 칸·빈 칸·이름 클릭 창의 단추를 **실제로 눌러** 바꾼다:
//   근무 바꾸기(D·E·N·DC·EC·NC·OF·V) · 자리 맞바꾸기 · 자동으로 되돌리기 · CRN 맡기기 · 쉬는 간호사 넣기 ·
//   대체간호사 넣기·빼기 · 이 날 교체 모두 풀기 · 효력 없는 교체 지우기 · 되돌리기(Ctrl+Z) ·
//   근무표 고치기 화면에서 칸에 자리까지 적기('D/B' — 우클릭 → 직접 입력)
// 병동 양식마다(내장 101·122·102·82, 올린 옛 102 D(CRN)·CN 이 둘째 줄인 101·자리표시자 102, 병동 양식 92(82 모양)·72(102 모양))
// 정해진 씨앗으로 무작위 수정을 하고, 한 번 바꿀 때마다 두 주 전체를 다시 본다:
//   E1 근무자가 모두 한 번씩 앉는다          E2 차지 표시가 정확히 한 사람         E3 자리가 앞에서부터 빈틈없이
//   E4 손으로 옮긴 자리는 그대로            E5 차지 = 규칙(표시 → 차지 가능 최선임 → 최선임; 차지 자리가 고정이면 손으로 앉힌 사람)
//   E6 차지 자리가 고정이면 차지는 그 자리   E6f 차지가 자리에 안 묶여도 종이에 찍히는 자리에 (손 안 탄 종이 자리가 남았으면)
//   E7 이틀 연속 같은 사람이면 자리도 같다 (차지가 자리에 안 묶이면 차지가 바뀌어도)
//   S  화면 줄 = 엔진 자리, /CRN 은 차지가 자리에 안 묶일 때 차지에게만
//   X  엑셀 = 화면 (자리 이름 줄마다 같은 사람), 엑셀 /CRN 은 서식이 찍을 때(102 모양)만, 신규 줄은 /CRN 뒤,
//      차지 자리가 고정이면 엑셀의 차지 표기 줄(CN·A(CN)·D(CRN))에 차지 — 화면과 엑셀이 같이 틀려도 잡는다
//   H  하루 어싸인표(hwpx) 줄 = 엔진 자리(차지가 자리에 안 묶이면 CN 줄에 차지), /CRN 은 화면과 같은 사람     P  인쇄(101 모양) = 화면
//   O  누른 단추가 한 일 (맞바꾼 자리, CRN 맡기기 후 차지·자리 그대로 — 앞 CRN 이 차지가 아니면 종이 밖 자리였을 사람이면 그 사람은 제자리로, DC 로 바꾸면 차지,
//      CRN 맡기기·DC 는 다른 사람의 근무 시간대를 안 바꾼다, 칸에 적은 자리가 그대로 들어간다, 되돌리기 = 바꾸기 전)
// 손 고정의 순서: 배정표에서 옮긴 자리 > 근무표 칸의 차지 표시(DC·EC·NC) > 근무표 칸에 적은 자리.
// 엔진만 보는 검사(원칙 1~4 × 정답 대조)는 test_assign_principles.mjs, 정해진 장면 회귀는 test_assign_logic.mjs.
//
// 크롬 경로: $CHROME → google-chrome → chromium → macOS Google Chrome 순. 씨앗 하나에 약 25초 (양식마다 30번) — CI 는 씨앗 셋.
// 이 검사가 못 잡는 엔진 쪽 고장(차지 자리 고르기)은 test_assign_principles.mjs 의 E12 가, 정해진 장면은 test_assign_logic.mjs 가 잡는다 —
// 일부러 넣은 고장 여섯으로 셋이 나눠 잡는지 확인했다 (docs/verification.md).
import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
// --seed 1,2,3 — 씨앗 여럿을 한 크롬에서 차례로 (CI 는 셋)
const SEEDS = String(arg('--seed', '1')).split(',').map(Number).filter(n => n > 0), OPS = +arg('--ops', 30), ONLY = arg('--only', '');
// 리포 폴더에는 개발자의 assign-data.js 가 있을 수 있다 — 사이드카가 없는 빈 폴더에 사본을 두고 띄운다
const WORK = mkdtempSync(join(tmpdir(), 'assign-live-'));
copyFileSync(resolve(ROOT, 'standalone/assign.html'), join(WORK, 'assign.html'));
const PAGE = 'file://' + encodeURI(join(WORK, 'assign.html'));
const PORT = 9611 + (process.pid % 200);

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
  console.log(`SKIP  이 Node 에는 전역 WebSocket 이 없습니다 (${process.version}, 22 이상 필요)`); process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// 1920×1080 — 기준 해상도. 확인 카드가 표 오른쪽 열에 선다
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--disable-gpu', '--no-first-run', '--window-size=1920,1080',
  '--no-default-browser-check', '--no-sandbox', '--allow-file-access-from-files',
  `--user-data-dir=${process.env.TMPDIR || '/tmp'}/assign-live-${process.pid}`, PAGE,
], { stdio: 'ignore' });

let ws, seq = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++seq; pending.set(id, { res, rej });
  ws.send(JSON.stringify({ id, method, params }));
});
let STEP = '(시작 전)';
async function ev(expr, ms = 30000) {
  // 돌려준 약속을 window 에 붙잡아 둔다 — 아무도 안 잡은 약속은 결과를 넘기기 전에 치워질 수 있다 (test_assign_logic 과 같다)
  const call = send('Runtime.evaluate', { expression: `window.__evKeep=(()=>{${expr}})()`, returnByValue: true, awaitPromise: true });
  const r = await Promise.race([call, sleep(ms).then(() => { throw new Error(`${ms}ms 안에 응답 없음 — ${STEP}`); })]);
  if (r.exceptionDetails) {
    const e = r.exceptionDetails.exception || {};
    throw new Error((e.description || e.value || JSON.stringify(r.exceptionDetails)) + ` — ${STEP}`);
  }
  return r.result.value;
}

/* ── 페이지 안에서 도는 쪽 ──────────────────────────────────────────────────────
 * 함수 그대로 넘긴다(toString) — 템플릿 문자열에 넣으면 정규식의 \d·\b 가 먼저 먹힌다. */
function LIB() {
  const A = window.__app, CORE = window.AssignCore;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const P3 = ['D', 'E', 'N'], LBL = ['차지', 'A', 'B', 'C', 'D', 'E'];
  const DAYS = 14, dateAt = i => new Date(2026, 8, 6 + i);          // 2026-09-06(일) ~ 09-19(토), 두 주
  const ISOS = [...Array(DAYS)].map((_, i) => A.isoOfD(dateAt(i)));
  const WARD = ['가간호', '나간호', '다간호', '라간호', '마간호', '바간호', '사간호', '아간호', '자간호', '차간호', '카간호', '타간호'];
  const NOCHG = ['나간호', '바간호'];                                  // DC·EC·NC 못 하는 사람
  const SU = ['파에스', '하에스'], TR = '신규하나', PRE = '다간호';
  const RELIEF = ['대체가', '대체나', '대체다'];
  let R = null, sp = null, model = [];

  function rng(seed) {          // mulberry32 — 같은 씨앗이면 같은 수정 순서
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const ri = n => Math.floor(R() * n), pick = a => a[ri(a.length)];
  const wpick = ws => { let t = ws.reduce((s, w) => s + w[1], 0) * R(); for (const w of ws) if ((t -= w[1]) < 0) return w[0]; return ws[0][0]; };
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = ri(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const S = () => A.store;
  const code = (n, iso) => { const pc = A.parseCellRaw(((S().cells[n] || {})[iso]) || ''); return pc && pc.code || ''; };
  const stateKey = () => JSON.stringify([S().cells, S().ovr, S().ovrPair, S().relief, S().trOv, S().trainee]);

  /* ── 장면 만들기 ── */
  async function setup(spec, seed) {
    sp = spec; R = rng(seed); model = [];
    const s = S();
    Object.assign(s, { formId: '101', order: WARD.concat(spec.su ? SU : [], [TR]), cells: {}, ovr: {}, ovrPair: {}, roomOv: {}, roomOvCnt: {},
      presetDay: {}, presetPlan: {}, presets: {}, seedManual: {}, unit: {}, relief: {}, trainee: {}, trOv: {}, evRules: [], daily: {},
      banRooms: {}, caps: {}, hidden: {}, newUntil: {}, forms: {} });
    s.rules = { keepSameShift: true, keepAcrossShift: true, keepAfterOff: true, bounceAfterOff: false };
    A.store = s;
    if (spec.ward) A.setWard(spec.ward); else { A.setFormId(spec.form); A.setWard(spec.form); }
    A.resetSchemes();
    // 올린 양식 — 관리 > 배정표 양식의 [양식 검사] → [이 양식 쓰기] 를 그대로 탄다
    if (spec.up || spec.ward) {
      const b = await A.loadBaseTemplate(spec.base || spec.form);
      let xml = b.sheetXml;
      if (spec.up === 'oldCrn') xml = A.setCellStr(xml, 'C8', 'D(CRN)');        // 옛 102: CRN 자리가 D 맨 아래 줄
      if (spec.up === 'cn2') { const lab = { 5: 'A', 6: 'CN', 7: 'B', 8: 'C', 9: 'D' }; for (const r in lab) xml = A.setCellStr(xml, 'C' + r, lab[r]); }
      if (spec.up === 'ph') { const m = A.autoMap(b); if (!m.ok) throw new Error('자동 맵핑 실패: ' + m.why); xml = m.xml; }
      const bytes = A.packXlsx(b, { 'xl/worksheets/sheet1.xml': xml });
      A.show('admin'); A.pickAdmin('form');
      await A.checkFormFile({ files: [new File([bytes], '올린 양식.xlsx')], set value(v) { /* 파일 칸 비우기 */ } });
      if (!A.useCheckedForm()) throw new Error('올린 양식을 쓰지 못했습니다');
      await A.loadTemplate(); await sleep(20);
    }
    for (const n of NOCHG) s.caps[n] = ['D', 'E', 'N'];
    // 근무표 — 사흘씩 같은 사람이 같은 근무 (실제 근무표처럼 이어지는 날이 있어야 E7 이 볼 것이 있다)
    for (let b = 0; b * 3 < DAYS; b++) {
      const perm = shuffle(WARD.slice()), blk = {}; let k = 0;
      for (const P of P3) { const [lo, hi] = spec.cnt[P], n = lo + ri(hi - lo + 1); for (let j = 0; j < n && k < perm.length; j++) blk[perm[k++]] = P; }
      for (let d = b * 3; d < Math.min(DAYS, b * 3 + 3); d++) for (const n of WARD) (s.cells[n] = s.cells[n] || {})[ISOS[d]] = blk[n] || 'OF';
    }
    // 차지 표시 — 날마다 근무마다 20% (가끔 둘 — 둘이면 그중 선임)
    for (const iso of ISOS) for (const P of P3) {
      const on = WARD.filter(n => s.cells[n][iso] === P);
      if (on.length && R() < 0.2) s.cells[pick(on)][iso] = P + 'C';
      if (on.length > 1 && R() < 0.04) s.cells[pick(on)][iso] = P + 'C';
    }
    // 신규 — 프리셉터와 같은 근무에 /D·/E·/N (이름 칸에 '/ 신규하나' 줄이 붙는다)
    s.trainee[TR] = { pre: PRE };
    for (const iso of ISOS) { const p = CORE.periodOf(s.cells[PRE][iso]); (s.cells[TR] = s.cells[TR] || {})[iso] = p ? '/' + p : 'OF'; }
    if (spec.su) {         // 82 모양 — SU 칸에만 들어가는 다른 소속
      for (const n of SU) s.unit[n] = 'SU';
      ISOS.forEach((iso, i) => { (s.cells[SU[0]] = s.cells[SU[0]] || {})[iso] = i % 3 === 2 ? 'OF' : 'D'; (s.cells[SU[1]] = s.cells[SU[1]] || {})[iso] = i % 2 ? 'E' : 'N'; });
    }
    A.recompute(); A.undoClear(); A.wkSunday = dateAt(0); A.show('week');
    return { form: A.formId(), kind: A.formDef().kind, float: P3.map(P => A.crnFloat(P)), crnMark: !!A.formDef().crnMark, canPrint: A.canPrint() };
  }

  /* ── 근무자·차지 규칙 (엔진을 보지 않고 근무표에서 바로) ── */
  const isRel = n => !S().order.includes(n);
  function workers(iso, P) {
    const s = S(), out = s.order.filter(n => !(s.unit || {})[n] && CORE.periodOf(code(n, iso)) === P);
    for (const n of A.reliefOn(iso, P)) if (!out.includes(n) && P3.find(Q => A.reliefOn(iso, Q).includes(n)) === P) out.push(n);
    return out;
  }
  function relOrder() { const out = []; for (const iso in S().relief) for (const P of P3) for (const n of A.reliefOn(iso, P)) if (!out.includes(n)) out.push(n); return out; }
  function sen(n) { const w = S().order.filter(x => !(S().unit || {})[x]), i = w.indexOf(n); return i >= 0 ? i : w.length + relOrder().indexOf(n); }
  // 근무표 칸에 적은 자리 이름('D/B' 의 B) → 앱 자리. 적는 글자는 배정표 종이의 자리 이름 (괄호 표기는 빼고 적어도 된다)
  const seatByPaper = (lb, P) => { const w = norm(lb).toUpperCase(), bare = x => x.replace(/[(].*[)]$/, '');
    return LBL.find(x => norm(A.FORM_LBL(x, P)).toUpperCase() === w) || LBL.find(x => bare(norm(A.FORM_LBL(x, P)).toUpperCase()) === w)
      || (!A.crnFloat(P) && /^(CR?N|차지)$/.test(w) ? '차지' : null); };
  // 지켜지는 손 고정 — 배정표에서 옮긴 자리(store.ovr) > 근무표 칸의 차지 표시(DC·EC·NC) > 근무표 칸에 적은 자리('D/B')
  function pins(iso, P, Ws, labels) {
    const ov = (S().ovr[iso] || {})[P] || {}, pr = (S().ovrPair[iso] || {})[P] || {};
    let t = [];
    // 근무표 칸의 자리 — 차지 자리가 고정이면 DC·EC·NC 칸은 차지 자리로 가고(다른 자리를 적어도), 차지 자리를 적은 보통 칸은
    // 그 날 다른 사람이 DC·EC·NC 면 표시를 따른다
    const fixed = !A.crnFloat(P), mark = S().order.some(n => !(S().unit || {})[n] && code(n, iso) === P + 'C');
    for (const n of S().order) {
      if (!Ws.has(n) || (S().unit || {})[n]) continue;
      const pc = A.parseCellRaw(((S().cells[n] || {})[iso]) || ''); if (!pc || !pc.label) continue;
      const seat = seatByPaper(pc.label, P); if (!seat) continue;
      if (fixed && pc.code === P + 'C' && seat !== '차지') continue;
      if (fixed && seat === '차지' && pc.code !== P + 'C' && mark) continue;
      t.push([n, seat]);
    }
    for (const nm in ov) {
      if (!Ws.has(nm)) continue;                     // 근무가 바뀌어 효력 없는 교체
      if (pr[nm] && !Ws.has(pr[nm])) continue;       // 맞바꾼 상대가 그 날 그 근무가 아니다
      const lb = ov[nm]; t = t.filter(([k, l]) => l !== lb && k !== nm); t.push([nm, lb]);
    }
    const out = {}, used = new Set();
    for (const [nm, lb] of t) if (labels.includes(lb) && !used.has(lb)) { out[nm] = lb; used.add(lb); }
    return out;
  }
  function expCharge(iso, P, W, pinned, float) {
    if (!float) { const h = Object.keys(pinned).find(n => pinned[n] === '차지'); if (h) return h; }
    const pool = float ? W : W.filter(n => !(n in pinned)), bySen = (a, b) => sen(a) - sen(b);
    const f = g => pool.filter(g).sort(bySen)[0];
    return f(n => !isRel(n) && code(n, iso) === P + 'C') || f(n => !isRel(n) && A.capsOf(n).includes(P + 'C')) || pool.slice().sort(bySen)[0] || null;
  }
  const seatOf = (d, n) => Object.keys(d.labels).find(l => d.labels[l] === n) || (d.extra.includes(n) ? '헬퍼' : '없음');
  const fmtD = d => LBL.filter(l => d.labels[l]).map(l => l + ':' + d.labels[l]).join(' ') + (d.extra.length ? ' +' + d.extra.join(',') : '');

  function checkEngine(out) {
    const res = A.result;
    if (!res) { out.push('E0 계산 결과가 없다'); return; }
    const info = {};
    for (const iso of ISOS) for (const P of P3) {
      const W = workers(iso, P), Ws = new Set(W), d = res.byDay[iso] && res.byDay[iso][P];
      if (!W.length) { if (d) out.push(`E1 ${iso} ${P} 근무자가 없는데 배정이 있다 (${fmtD(d)})`); continue; }
      if (!d) { out.push(`E1 ${iso} ${P} 근무자 ${W.join(',')} 인데 배정이 없다`); continue; }
      const mem = Object.values(d.labels).concat(d.extra);
      if (mem.length !== new Set(mem).size || mem.length !== W.length || mem.some(n => !Ws.has(n)))
        out.push(`E1 ${iso} ${P} 앉은 사람 ${fmtD(d)} ≠ 근무자 ${W.join(',')}`);
      const labels = LBL.slice(0, Math.min(W.length, A.seatsFor(P)));
      if (Object.keys(d.labels).sort().join() !== labels.slice().sort().join()) out.push(`E3 ${iso} ${P} 자리 ${Object.keys(d.labels).join(',')} — 기대 ${labels.join(',')}`);
      const flags = W.filter(n => ((res.byNurse[n] || {})[iso] || {}).charge);
      if (flags.length !== 1 || flags[0] !== d.charge) out.push(`E2 ${iso} ${P} 차지 표시 ${flags.join(',') || '없음'} (그 날 차지 ${d.charge})`);
      const float = A.crnFloat(P), pinned = pins(iso, P, Ws, labels);
      for (const n in pinned) if (d.labels[pinned[n]] !== n) out.push(`E4 ${iso} ${P} ${n} 을 손으로 ${pinned[n]} 에 두었는데 ${seatOf(d, n)} (${fmtD(d)})`);
      const want = expCharge(iso, P, W, pinned, float);
      if (d.charge !== want) out.push(`E5 ${iso} ${P} 차지 ${d.charge} — 규칙대로면 ${want} (${float ? '차지가 자리에 안 묶임' : '차지 자리 고정'}; ${fmtD(d)})`);
      if (!float && d.labels['차지'] !== d.charge) out.push(`E6 ${iso} ${P} 차지 ${d.charge} 가 차지 자리가 아니다 (${fmtD(d)})`);
      // E6f — 차지가 자리에 안 묶여도 종이에는 찍혀야 한다: 손으로 앉힌 차지가 아니고 손 안 탄 종이 자리가 남아 있으면 그중 하나에
      const ps = A.paperSeat(P);
      if (float && d.charge && !(d.charge in pinned) && labels.some(l => ps.on(l) && !Object.values(pinned).includes(l)) && !ps.on(seatOf(d, d.charge)))
        out.push(`E6f ${iso} ${P} CRN ${d.charge} 이 종이 밖 자리 ${seatOf(d, d.charge)} (${fmtD(d)})`);
      info[iso + P] = { W, d, pinned, labels };
    }
    // E7 — 102 오류가 깬 불변식: 이틀 연속 같은 사람이면(손 고정 없음, 방 구성 같음) 자리도 같다.
    // 차지가 자리에 안 묶이는 서식은 차지가 바뀌어도 (/CRN 은 사람에 붙는다). 원칙 1(같은 근무 유지)이 켜져 있을 때
    if (S().rules.keepSameShift) for (let i = 0; i + 1 < DAYS; i++) for (const P of P3) {
      const a = info[ISOS[i] + P], b = info[ISOS[i + 1] + P];
      if (!a || !b || a.W.length !== b.W.length || a.W.some(n => !b.W.includes(n))) continue;
      if (Object.keys(a.pinned).length || Object.keys(b.pinned).length) continue;
      if (!A.crnFloat(P) && a.d.charge !== b.d.charge) continue;
      const cnt = a.W.length;
      if (a.labels.some(l => A.roomsFor(P, cnt, l, ISOS[i]) !== A.roomsFor(P, cnt, l, ISOS[i + 1]))) continue;
      if (fmtD(a.d) === fmtD(b.d)) continue;
      // 새 차지가 어제 종이 밖 자리(양식 줄을 넘는 자리)였으면 종이로 올라와야 한다 — 그 사람과 밀려나는 한 사람만 옮긴다
      const nc = b.d.charge, ncSeat = Object.keys(a.d.labels).find(l => a.d.labels[l] === nc);
      const moved = a.W.filter(n => seatOf(a.d, n) !== seatOf(b.d, n));
      if (A.crnFloat(P) && a.d.charge !== nc && !(ncSeat && A.crnSeats(P).includes(ncSeat)) && A.crnSeats(P).includes(seatOf(b.d, nc)) && moved.length <= 2 && moved.includes(nc)) continue;
      out.push(`E7 ${ISOS[i]}→${ISOS[i + 1]} ${P} 같은 사람인데 자리가 바뀜: ${fmtD(a.d)} → ${fmtD(b.d)}` +
        (a.d.charge !== nc ? ` (차지 ${a.d.charge}→${nc})` : ''));
    }
  }

  /* ── 화면·엑셀·하루 어싸인표·인쇄 ── */
  const norm = v => String(v || '').replace(/\s+/g, '');
  // 화면 한 주 — {날짜:{D:[{lab, n, crn, tr}]…}} 위에서부터. SU·중간번 줄은 mid:true
  function screenWeek(isos) {
    const o = {}; for (const iso of isos) o[iso] = { D: [], E: [], N: [] };
    let cur = null;
    for (const tr of document.querySelectorAll('#wkTable tr')) {
      const sc = tr.querySelector('td.seccol'); if (sc) cur = sc.textContent.trim();
      const lab = tr.querySelector('td.lab'); if (!lab || !cur) continue;
      const mid = !!tr.querySelector('td.mid');
      for (const iso of isos) {
        const td = tr.querySelector('td.nm[data-iso="' + iso + '"]');
        o[iso][cur].push({ lab: lab.textContent.trim(), mid, n: td ? td.dataset.n : '', crn: !!(td && td.querySelector('.crnTag')),
          tr: td ? [...td.querySelectorAll('.trn')].map(x => x.textContent.trim()) : [] });
      }
    }
    return o;
  }
  const splitName = t => { const ls = String(t || '').split('\n'), f = ls[0] || '';
    return { n: f.replace(/\s*[/]CRN\s*$/, '').trim(), crn: /[/]CRN\s*$/.test(f), tr: ls.slice(1).map(x => x.trim()).filter(Boolean), raw: t || '' }; };
  async function excelWeek(sun, isos) {
    const r = await A.buildWeekXlsx(new Date(sun)), cells = A.sheetCells({ ...r.tpl, sheetXml: r.xml });
    const base = await A.loadBaseTemplate(sp.base || sp.form), F = A.formDef(), kind = F.kind;
    const L = A.layoutOf({ kind: kind === '82' ? '82' : kind }, A.sheetCells(base), A.sheetMerges(base));
    const o = {};
    isos.forEach((iso, di) => {
      o[iso] = {};
      const c = L.dateCols[di], nc = kind === '122' || F.noRooms ? c : c + 1;
      for (const sec of L.sections) {
        const rows = kind === '101' && L.labelRows ? L.labelRows.filter(r => r >= sec.row && (!sec.end || r < sec.end))
          : [...Array(sec.rows)].map((_, k) => sec.row + k);
        o[iso][sec.P] = rows.map(r => Object.assign({ lab: kind === '122' ? '' : String(cells[A.colName(L.labelCol || 3) + r] || '').trim(), r },
          splitName(cells[A.colName(nc) + r])));
      }
    });
    return o;
  }
  function printWeek(isos) {
    const o = {}; for (const iso of isos) o[iso] = { D: [], E: [], N: [] };
    const tb = document.querySelector('#printArea .sheet table'); if (!tb) return null;
    let cur = null;
    for (const tr of tb.querySelectorAll('tr')) {
      const rl = tr.querySelector('td[class^="rail"]'); if (rl) cur = rl.textContent.trim();
      const lab = tr.querySelector('td.lab'); if (!lab || !cur) continue;
      const tds = [...tr.children]; const k0 = tds.indexOf(lab) + 1;
      isos.forEach((iso, di) => { const td = tds[k0 + di * 2 + 1];
        o[iso][cur].push({ lab: lab.textContent.trim(), n: td && td.classList.contains('pnm') ? (td.childNodes[0] ? td.childNodes[0].textContent.trim() : '') : '' }); });
    }
    return o;
  }

  async function checkViews(out, wk, dayIso) {
    const sun = dateAt(wk * 7), isos = ISOS.slice(wk * 7, wk * 7 + 7), res = A.result, F = A.formDef(), kind = F.kind;
    A.wkSunday = new Date(sun); A.show('week');
    const scr = screenWeek(isos), xl = await excelWeek(sun, isos);
    let pr = null;
    if (kind === '101' && A.canPrint()) { await A.buildPrintArea(false); pr = printWeek(isos); }
    for (const iso of isos) for (const P of P3) {
      const d = res.byDay[iso] && res.byDay[iso][P], rows = scr[iso][P].filter(r => !r.mid), float = A.crnFloat(P), ps = A.paperSeat(P);
      const L = d ? d.labels : {}, chg = d && d.charge;
      // S — 화면 줄의 자리 이름 = 엔진 자리의 종이 이름
      if (new Set(rows.map(r => norm(r.lab))).size !== rows.length) out.push(`S0 ${iso} ${P} 화면에 같은 자리 이름 줄이 둘 (${rows.map(r => r.lab).join(',')})`);
      for (const r of rows) if (r.n) {
        const l = Object.keys(L).find(x => L[x] === r.n);
        if (!l || norm(A.FORM_LBL(l, P)) !== norm(r.lab)) out.push(`S1 ${iso} ${P} 화면 '${r.lab}' 줄에 ${r.n} — 엔진 자리는 ${l ? A.FORM_LBL(l, P) : '없음'}`);
        if (r.crn !== (float && r.n === chg)) out.push(`S2 ${iso} ${P} 화면 ${r.n} 의 /CRN ${r.crn ? '있음' : '없음'} — 차지 ${chg}, ${float ? '차지가 자리에 안 묶임' : '차지 자리 고정'}`);
      }
      for (const l in L) if (ps.on(l) && !rows.some(r => r.n === L[l])) out.push(`S3 ${iso} ${P} ${L[l]}(${A.FORM_LBL(l, P)}) 이 종이에는 찍히는데 화면에 없다`);
      // X — 엑셀 = 화면
      const xr = (xl[iso] || {})[P] || [];
      if (kind === '122') {
        rows.forEach((r, k) => { const x = xr[k]; if (!x) return;
          if (x.n !== (r.n || '')) out.push(`X1 ${iso} ${P} 엑셀 ${k + 1}째 줄 '${x.n}' — 화면 ${r.lab} 줄 '${r.n}'`); });
      } else {
        for (const x of xr) {
          if (/^SU$/i.test(norm(x.lab))) { const su = A.unitWorker(iso, P, 'SU'); if (x.n !== su) out.push(`X1 ${iso} ${P} 엑셀 SU 줄 '${x.n}' — SU 근무 '${su}'`); continue; }
          if (/^중간번?$/.test(norm(x.lab))) continue;
          const r = rows.find(q => norm(q.lab) === norm(x.lab));
          if (!r) { if (x.n) out.push(`X0 ${iso} ${P} 엑셀 '${x.lab}' 줄(${x.r}행)에 ${x.n} — 화면에 그 줄이 없다`); continue; }
          if (x.n !== (r.n || '')) out.push(`X1 ${iso} ${P} 엑셀 '${x.lab}' 줄 '${x.n}' — 화면 '${r.n}'`);
        }
        for (const r of rows) if (r.n && !xr.some(x => norm(x.lab) === norm(r.lab))) out.push(`X0 ${iso} ${P} 화면 '${r.lab}' 줄(${r.n})이 엑셀에 없다`);
      }
      const crnPaper = !!F.crnMark && float;
      for (const x of xr) if (x.n && !/^SU$/i.test(norm(x.lab))) {
        if (x.crn !== (crnPaper && x.n === chg)) out.push(`X2 ${iso} ${P} 엑셀 '${x.raw.replace(/\n/g, '⏎')}' 의 /CRN — 차지 ${chg}, ${crnPaper ? '서식이 /CRN 을 찍는다' : '서식이 /CRN 을 찍지 않는다'}`);
        if (x.tr.some(t => /CRN/.test(t))) out.push(`X3 ${iso} ${P} 엑셀 '${x.raw.replace(/\n/g, '⏎')}' — /CRN 이 신규 줄 뒤`);
        const r = rows.find(q => q.n === x.n);
        if (r && r.tr.join('|') !== x.tr.join('|')) out.push(`X4 ${iso} ${P} ${x.n} 신규 줄 — 화면 ${r.tr.join(',') || '없음'} · 엑셀 ${x.tr.join(',') || '없음'}`);
      }
      // X5 — 차지 자리가 고정인 양식은 엑셀에서 이름표가 차지 표기(CN·A(CN)·D(CRN))인 줄에 차지가 — 화면과 엑셀이 같이 틀리면 X1 은 못 본다
      if (!float && kind !== '122' && chg) { const cx = xr.find(x => /CRN|(^|[(])CN(?![A-Za-z])/i.test(norm(x.lab)));
        if (cx && cx.n !== chg) out.push(`X5 ${iso} ${P} 엑셀 차지 줄 '${cx.lab}' 에 ${cx.n || '(빈칸)'} — 차지 ${chg}`); }
      // P — 인쇄 = 화면 (101 모양)
      if (pr) {
        const pp = pr[iso][P];
        if (pp.map(q => norm(q.lab)).join() !== rows.slice(0, pp.length).map(q => norm(q.lab)).join())
          out.push(`P1 ${iso} ${P} 인쇄 줄 ${pp.map(q => q.lab).join(',')} — 화면 줄 ${rows.map(q => q.lab).join(',')}`);
        pp.forEach((q, k) => { const r = rows[k]; if (r && q.n !== (r.n || '')) out.push(`P2 ${iso} ${P} 인쇄 '${q.lab}' 줄 '${q.n}' — 화면 '${r.n}'`); });
      }
    }
    // H — 하루 어싸인표 (그 날)
    if (dayIso) {
      A.DAYTPL = null;
      const dd = await A.buildDayDoc(dayIso), M = A.dayLayout(dd.doc).main;
      for (const P of P3) {
        const sc = M.shifts[P], d = res.byDay[dayIso] && res.byDay[dayIso][P]; if (!sc) continue;
        const float = A.crnFloat(P), L = d ? d.labels : {};
        // 차지가 자리에 안 묶이면 CN 줄(첫 줄 이름표가 CN·CRN)에는 차지가 선다 — 나머지는 자리 순서
        const cnRow = M.rows[0] && /CRN|(^|[(])CN(?![A-Za-z])/i.test(M.rows[0].label.replace(/\s+/g, ''));
        const cs = float && cnRow && d && d.charge ? Object.keys(L).find(l => L[l] === d.charge) : null;
        const ord = cs ? [cs, ...LBL.filter(l => l !== cs)] : LBL;
        M.rows.forEach((row, i) => {
          const q = M.m.at(row.r, sc.nurse), h = splitName(q ? q.text : ''), want = L[ord[i]] || '';
          if (h.n !== want) out.push(`H1 ${dayIso} ${P} 하루 어싸인표 ${i + 1}째 줄 '${h.n}' — 엔진 ${ord[i]} 자리 '${want}'`);
          if (i === 0 && cnRow && float && d && d.charge && h.n !== d.charge) out.push(`H4 ${dayIso} ${P} 하루 어싸인표 CN 줄 '${h.n}' — 차지 ${d.charge}`);
          if (h.n && h.crn !== (float && h.n === d.charge)) out.push(`H2 ${dayIso} ${P} 하루 어싸인표 ${h.n} 의 /CRN ${h.crn ? '있음' : '없음'} — 차지 ${d.charge}`);
          if (h.tr.some(t => /CRN/.test(t))) out.push(`H3 ${dayIso} ${P} 하루 어싸인표 '${h.raw.replace(/\n/g, '⏎')}' — /CRN 이 신규 줄 뒤`);
        });
      }
    }
  }

  /* ── 수정 하나 — 사람이 누르는 대로 ── */
  const pk = () => document.querySelector('#pick');
  const pickOn = () => pk().style.display === 'block';
  const btnIn = (root, re) => [...root.querySelectorAll('button')].find(b => re.test(b.textContent) && !b.disabled);
  const modalOn = () => document.querySelector('#modal').classList.contains('on');
  const cellsOn = (iso, f) => [...document.querySelectorAll('#wkTable td.nm[data-iso="' + iso + '"]')].filter(f || (() => true));
  const rowP = td => { let tr = td.closest('tr'); while (tr) { const sc = tr.querySelector('td.seccol'); if (sc) return sc.textContent.trim(); tr = tr.previousElementSibling; } return null; };
  const byDayJson = () => JSON.stringify(A.result && A.result.byDay);
  async function chooseModal(f) {     // 열린 고르기 창에서 하나 — 둘째 창(차지로 넣을까요?)이 이어 뜨면 그것도
    for (let k = 0; k < 3 && modalOn(); k++) {
      const opts = [...document.querySelectorAll('#modalBox button[data-g]')];
      if (!opts.length) break;
      (f ? f(opts) : pick(opts)).click(); await sleep(15);
    }
  }
  async function op(i) {
    if (pickOn()) A.closePick(); if (modalOn()) A.closeModal(null);
    const di = ri(DAYS), iso = ISOS[di], wk = di < 7 ? 0 : 1;
    A.wkSunday = dateAt(wk * 7); A.show('week');
    // 되돌리기는 40단계까지 — 꽉 차면 기록이 늘었는지 셀 수 없으니 비우고 다시 센다
    if (A.undoDepth >= 38) { A.undoClear(); model = []; }
    const before = stateKey(), depth = A.undoDepth, res0 = byDayJson(), cells0 = JSON.parse(JSON.stringify(S().cells));
    // CRN 맡기기 단추는 차지가 자리에 안 묶이는 근무에만 있다 — 그런 양식에서 더 자주 (102 오류가 드러난 수정이다)
    const crnW = P3.some(P => A.crnFloat(P)) ? 20 : 2;
    const kind = wpick([['shift', 22], ['swap', 24], ['auto', 6], ['crn', crnW], ['cellSeat', 8], ['addOff', 7], ['relief', 8], ['unrelief', 5], ['clearDay', 4], ['prune', 2], ['undo', 10]]);
    const fails = [], ctx = { kind, iso, wk };
    const all = cellsOn(iso);
    const openName = async td => { td.click(); await sleep(5); return pickOn(); };
    if (kind === 'undo') {
      if (!A.undoDepth) return { desc: `되돌리기 ${iso} (되돌릴 것 없음)`, fails, ctx };
      const want = model.pop(); A.undoAny(); await sleep(10);
      if (want && stateKey() !== want) fails.push('U1 되돌리기(Ctrl+Z)가 바로 전 수정 전으로 돌아가지 않았다');
      return { desc: `되돌리기 (${iso})`, fails, ctx };
    }
    let desc = kind + ' ' + iso;
    if (kind === 'cellSeat') {
      // 근무표 고치기 화면에서 칸에 자리까지 적는다 — 우클릭 → [✏ 직접 입력] → 'D/B' (자리 이름은 배정표 종이의 이름)
      const td = pick(all.filter(t => WARD.includes(t.dataset.n)));
      if (!td) return { desc: desc + ' (누를 칸 없음)', fails, ctx };
      const name = td.dataset.n, P = rowP(td), cd = code(name, iso), d = A.result.byDay[iso][P];
      const taken = new Set(S().order.filter(n => n !== name).map(n => { const pc = A.parseCellRaw(((S().cells[n] || {})[iso]) || '');
        return pc && pc.label && CORE.periodOf(pc.code) === P ? seatByPaper(pc.label, P) : null; }).filter(Boolean));
      // 칸에 적을 수 있는 자리 이름은 A~F·CN 꼴뿐이다 — 82 의 '대체'·'ward' 같은 종이 이름은 근무 표기로 안 읽힌다
      const free = Object.keys(d.labels).filter(l => !taken.has(l) && /^([A-F]([(]C?R?N[)])?|C?R?N)$/i.test(norm(A.FORM_LBL(l, P))));
      if (!cd || !free.length) return { desc: desc + ` ${P} ${name} (적을 자리 없음)`, fails, ctx };
      const l = pick(free); let lb = A.FORM_LBL(l, P); if (R() < 0.3) lb = lb.replace(/[(].*[)]$/, '');
      const txt = cd + '/' + lb;
      Object.assign(ctx, { name, P, cellSeat: l });
      desc += ` ${P} ${name} → 칸에 '${txt}'`;
      A.show('edit'); await sleep(10);
      const th = [...document.querySelectorAll('#wrap th.nm[data-nr]')].find(x => x.firstChild && x.firstChild.textContent === name);
      const cell = th && document.querySelector('#wrap td.cell[data-r="' + th.dataset.nr + '"][data-c="' + (+iso.slice(8) - 1) + '"]');
      if (!cell) { fails.push(`O0 고치기 화면에 ${name} ${iso} 칸이 없다`); A.show('week'); return { desc, fails, ctx }; }
      cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); window.dispatchEvent(new MouseEvent('mouseup'));
      cell.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      await sleep(15);
      if (!modalOn()) { fails.push(`O0 ${name} ${iso} 칸을 우클릭했는데 근무 고르기 창이 안 열렸다`); A.show('week'); return { desc, fails, ctx }; }
      document.querySelector('#mdTextBtn').click(); document.querySelector('#mdInput').value = txt; document.querySelector('#mdOk').click();
      await sleep(15);
      if (code(name, iso) !== cd || seatByPaper((A.parseCellRaw(S().cells[name][iso]) || {}).label, P) !== l) fails.push(`O9 칸에 '${txt}' 를 적었는데 칸은 '${S().cells[name][iso]}'`);
      A.show('week');
    }
    else if (kind === 'prune') { A.show('admin'); A.pickAdmin('manual'); A.pruneOvr(); A.show('week'); desc = '효력 없는 교체 지우기'; }
    else if (kind === 'addOff' || kind === 'relief') {
      const emp = [...document.querySelectorAll('#wkTable td[data-empty][data-iso="' + iso + '"]')].filter(td => !td.classList.contains('rm'));
      let opened = false;
      if (emp.length && R() < 0.5) { const td = pick(emp); td.click(); await sleep(5);
        const b = [...pk().querySelectorAll('.addBtn')][kind === 'addOff' ? 0 : 1]; if (b && !b.disabled) { b.click(); opened = true; desc += ` 빈 칸(${td.dataset.p} ${td.dataset.l})`; } }
      else if (all.length) { const td = pick(all); if (await openName(td)) { const b = btnIn(pk(), kind === 'addOff' ? /쉬는 간호사 넣기/ : /대체간호사 넣기/);
        if (b) { b.click(); opened = true; desc += ` ${rowP(td)} (${td.dataset.n} 창에서)`; } } }
      await sleep(15);
      if (!opened || !modalOn()) desc += ' (넣을 길 없음)';
      else if (kind === 'addOff') { await chooseModal(); ctx.add = true; }
      else {
        const here = A.reliefDay(iso), nm = RELIEF.find(n => !here.includes(n));
        if (!nm) { A.closeModal(null); desc += ' (대체 이름 다 씀)'; }
        else { document.querySelector('#mdInput').value = nm; document.querySelector('#mdOk').click(); desc += ' → ' + nm; ctx.relief = nm; }
      }
      await sleep(15);
    } else {
      let td = null;
      if (kind === 'auto') td = pick(cellsOn(iso, t => t.classList.contains('ovd')).concat(all));
      else if (kind === 'unrelief') td = pick(cellsOn(iso, t => RELIEF.includes(t.dataset.n)));
      else if (kind === 'clearDay') td = pick(all.filter(t => { const P = rowP(t); return (S().ovr[iso] || {})[P]; })) || pick(all);
      else td = pick(all);
      if (!td) return { desc: desc + ' (누를 칸 없음)', fails, ctx };
      const name = td.dataset.n, P = rowP(td);
      ctx.name = name; ctx.P = P; ctx.seat0 = ((A.result.byNurse[name] || {})[iso] || {}).label || null; ctx.chg0 = A.result.byDay[iso][P].charge;
      desc += ` ${P} ${name}`;
      if (!(await openName(td))) { fails.push(`O0 ${iso} ${name} 이름을 눌렀는데 창이 안 열렸다`); return { desc, fails, ctx }; }
      if (kind === 'shift') {
        const c = wpick([['D', 3], ['E', 3], ['N', 2], ['DC', 2], ['EC', 2], ['NC', 2], ['OF', 3], ['V', 1]]);
        const b = [...pk().querySelectorAll('.shl button')].find(x => x.textContent.trim() === c);
        if (b) { b.click(); desc += ' → ' + c; ctx.code = c; } else { A.closePick(); desc += ' (근무 단추 없음 — 대체간호사)'; }
      } else if (kind === 'swap') {
        const bs = [...pk().querySelectorAll('.swapBtn:not([disabled])')];
        if (bs.length) { const b = pick(bs), m = (b.getAttribute('onclick') || '').match(/pickChoose[(]'([^']+)'/); b.click(); ctx.to = m && m[1];
          desc += ' ↔ ' + (b.querySelector('.lb') || b).textContent.trim(); ctx.holder = A.result && null; }
        else { A.closePick(); desc += ' (맞바꿀 자리 없음)'; }
      } else {
        const re = { auto: /자동으로 되돌리기/, crn: /CRN 맡기기/, unrelief: /이 날 빼기/, clearDay: /교체 모두 풀기/ }[kind];
        const b = btnIn(pk(), re);
        if (b) b.click(); else { A.closePick(); desc += ' (단추 없음)'; ctx.none = true; }
      }
      await sleep(15);
    }
    if (modalOn()) { A.closeModal(null); desc += ' (창 닫음)'; }
    await sleep(5);
    // 되돌리기 기록 — 바꾼 수정은 Ctrl+Z 로 돌아와야 한다
    const changed = stateKey() !== before, pushed = A.undoDepth > depth;
    if (pushed) { model.push(before); if (model.length > 40) model.shift(); }
    else if (changed) fails.push('U2 바뀌었는데 되돌리기(Ctrl+Z) 기록이 없다');
    // O — 누른 단추가 한 일
    const res = A.result, dN = (n, P) => ((res.byNurse[n] || {})[iso] || {}), day = P => (res.byDay[iso] || {})[P];
    if (kind === 'swap' && ctx.to) {
      if (dN(ctx.name, ctx.P).label !== ctx.to) fails.push(`O1 ${ctx.name} 을 ${ctx.to} 자리로 맞바꿨는데 ${dN(ctx.name, ctx.P).label || '자리 없음'}`);
      if (A.crnFloat(ctx.P) && day(ctx.P).charge !== ctx.chg0) fails.push(`O2 차지가 자리에 안 묶이는데 자리를 맞바꾸니 차지가 ${ctx.chg0}→${day(ctx.P).charge}`);
    }
    const chgCode = kind === 'shift' && /^(DC|EC|NC)$/.test(ctx.code || '');
    if ((kind === 'crn' && !ctx.none) || chgCode) {
      const P = chgCode ? ctx.code[0] : ctx.P;
      if ((day(P) || {}).charge !== ctx.name) fails.push(`O3 ${kind === 'crn' ? 'CRN 맡기기' : ctx.code + ' 로 바꾸기'} 뒤 ${iso} ${P} 차지가 ${(day(P) || {}).charge} — ${ctx.name} 이어야`);
      // 차지가 자리에 안 묶이면 CRN 을 바꿔도 아무도 자리를 옮기지 않는다 (CRN 이 종이 자리에 앉아 있었다면)
      if (A.crnFloat(P) && P === ctx.P && ctx.seat0 && A.crnSeats(P).includes(ctx.seat0)) {
        const a = JSON.parse(res0), b = res.byDay;
        // 예외 하나: 앞 CRN 이 차지가 아니면 종이 밖 자리(양식 칸을 넘는 자리)였을 사람 — CRN 이라 종이에 앉혔던 것이니
        // CRN 을 넘기면 제자리(종이 밖)로 가고, 그 때문에 밀려났던 사람들이 제자리로 돌아온다(하나일 수도, 줄줄이일 수도 있다).
        // 그 날과 그 뒤 날들은 맞게 달라진다 — 달라진 배치가 '아무도 차지가 아닐 때의 배치'인지는 E12 가 엔진 쪽에서 본다
        // 예외는 앞 CRN 이 그 근무에 그대로 있고(근무가 바뀌었으면 O8 이 본다) 종이 밖으로 갔을 때만, 그 날은 그 근무만
        const db = (b[iso] || {})[P], s0 = db ? seatOf(db, ctx.chg0) : '없음';
        const back = s0 !== '없음' && !A.crnSeats(P).includes(s0);
        const diff = (k, Q) => a[k][Q] && b[k] && b[k][Q] && fmtD(a[k][Q]) !== fmtD(b[k][Q]) && !(back && (k > iso || (k === iso && Q === P)));
        const mv = Object.keys(a).filter(k => P3.some(Q => diff(k, Q)));
        if (mv.length) fails.push(`O4 CRN 을 ${ctx.chg0}→${ctx.name} 로 바꿨더니 자리가 바뀐 날: ${mv.map(k => k + ' ' + P3.filter(Q => diff(k, Q)).map(Q => Q + ' ' + fmtD(a[k][Q]) + ' → ' + fmtD(b[k][Q])).join(' / ')).join(' ; ')}`);
      }
    }
    // O8 — CRN 맡기기·DC 로 바꾸기는 다른 사람의 근무 시간대를 바꾸지 않는다 (앞 차지의 DC 는 D 로 — 시간대 그대로)
    if ((kind === 'crn' && !ctx.none) || chgCode) for (const n in cells0) if (n !== ctx.name) for (const dk in cells0[n]) {
      const a0 = CORE.periodOf((A.parseCellRaw(cells0[n][dk]) || {}).code), b0 = CORE.periodOf(code(n, dk));
      if (a0 !== b0) fails.push(`O8 ${kind} 뒤 ${n} ${dk} 근무 ${cells0[n][dk]} → ${(S().cells[n] || {})[dk] || '없음'}`); }
    if (kind === 'auto' && !ctx.none && ((S().ovr[iso] || {})[ctx.P] || {})[ctx.name] !== undefined) fails.push(`O5 자동으로 되돌리기 뒤에도 ${ctx.name} 의 손 고정이 남았다`);
    if (kind === 'clearDay' && !ctx.none && (S().ovr[iso] || {})[ctx.P]) fails.push(`O6 이 날 교체 모두 풀기 뒤에도 ${ctx.P} 교체가 남았다`);
    if (ctx.relief && !A.reliefDay(iso).includes(ctx.relief)) fails.push(`O7 대체간호사 ${ctx.relief} 가 들어가지 않았다`);
    return { desc, fails, ctx };
  }

  async function check(r) {
    const out = [];
    // 양식을 읽는 중이면 다 읽고 다시 계산·그린 뒤에 본다 (loadTemplate 이 자리 이름·차지 자리를 알면 setTimeout 으로 다시 그린다)
    await A.loadTemplate(); await sleep(10);
    checkEngine(out);
    const wk = r && r.ctx ? r.ctx.wk : 0, dayIso = r && r.ctx ? r.ctx.iso : ISOS[0];
    await checkViews(out, wk, dayIso);
    return out;
  }
  return { setup, op, check, ISOS };
}

/* ── 병동 양식 ── */
const SPECS = [
  { key: '101', form: '101', cnt: { D: [4, 5], E: [4, 5], N: [2, 3] } },
  { key: '122', form: '122', cnt: { D: [5, 6], E: [4, 5], N: [2, 3] } },
  { key: '102', form: '102', cnt: { D: [3, 5], E: [3, 4], N: [2, 3] } },
  { key: '82', form: '82', su: true, cnt: { D: [2, 3], E: [2, 3], N: [1, 2] } },
  { key: '102 옛 양식(D(CRN) 맨 아래)', form: '102', up: 'oldCrn', cnt: { D: [3, 5], E: [3, 4], N: [2, 3] } },
  { key: '101 올린 양식(CN 이 둘째 줄)', form: '101', up: 'cn2', cnt: { D: [4, 5], E: [4, 5], N: [2, 3] } },
  { key: '102 자리표시자 양식', form: '102', up: 'ph', cnt: { D: [3, 5], E: [3, 4], N: [2, 3] } },
  { key: '92병동 양식(82 모양)', ward: '92', base: '82', su: true, cnt: { D: [2, 3], E: [2, 3], N: [1, 2] } },
  { key: '72병동 양식(102 모양)', ward: '72', base: '102', cnt: { D: [3, 5], E: [3, 4], N: [2, 3] } },
];

async function main() {
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    try { target = JSON.parse(execSync(`curl -s http://127.0.0.1:${PORT}/json`).toString()).find(t => t.type === 'page' && t.url.includes('assign.html')); }
    catch { /* 아직 안 떴다 */ }
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
  for (let i = 0; i < 60; i++) { if (await ev('return !!(window.__app && window.__app.splitBed)')) break; await sleep(250); }
  // 대화상자는 막는다 — 헤드리스에서 뜨면 평가가 돌아오지 않는다
  await ev(`window.confirm=()=>true; window.alert=()=>{}; window.prompt=()=>null;
    window.__pageErrors=[]; window.addEventListener('error',e=>window.__pageErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection',e=>window.__pageErrors.push('약속 거절: '+String(e.reason&&e.reason.message||e.reason)));
    window.__app.memoryMode(); window.__lt=(${LIB.toString()})(); return 1`);

  let bad = 0, total = 0;
  const specs = SPECS.filter(s => !ONLY || s.key.includes(ONLY));
  for (const SEED of SEEDS) for (let si = 0; si < specs.length; si++) {
    const sp = specs[si];
    STEP = `씨앗 ${SEED} ${sp.key} 준비`;
    const info = await ev(`return window.__lt.setup(${JSON.stringify(sp)}, ${SEED * 1000 + si})`, 60000);
    const pre = await ev('return window.__lt.check(null)', 60000);
    const hist = [];
    let fails = pre.length ? pre.map(f => '(수정 전) ' + f) : [];
    for (let i = 0; i < OPS && !fails.length; i++) {
      STEP = `씨앗 ${SEED} ${sp.key} 수정 ${i + 1}`;
      const r = await ev(`return window.__lt.op(${i})`, 30000);
      hist.push(r.desc);
      const c = await ev(`return window.__lt.check(${JSON.stringify({ ctx: r.ctx })})`, 60000);
      fails = r.fails.concat(c);
      total++;
    }
    const tag = `${sp.key} [${info.kind} 모양 · 차지 ${info.float.map((f, k) => 'DEN'[k] + (f ? ' 자리 안 묶임' : ' 자리 고정')).join(', ')}${info.crnMark ? ' · 종이에 /CRN' : ''}${info.canPrint ? ' · 화면 인쇄' : ''}]`;
    if (fails.length) {
      bad++;
      console.log(`FAIL  ${tag} — 씨앗 ${SEED}, ${hist.length}번째 수정 뒤`);
      for (const f of fails.slice(0, 8)) console.log('      ' + f);
      if (fails.length > 8) console.log(`      … 외 ${fails.length - 8}건`);
      console.log('      수정 순서: ' + hist.slice(-12).map((h, k) => `${hist.length - Math.min(12, hist.length) + k + 1}) ${h}`).join('\n                 '));
    } else {
      console.log(`ok    ${tag} — 씨앗 ${SEED}, ${hist.length}번 수정`);
      if (process.env.VERBOSE) for (const h of hist) console.log('        ' + h);
    }
  }
  const errs = await ev('return window.__pageErrors||[]');
  if (errs.length) { bad++; console.log('FAIL  페이지 오류: ' + errs.slice(0, 5).join(' | ')); }
  console.log(bad ? `assign 실시간 수정: 양식 ${specs.length}개 × 씨앗 ${SEEDS.length}개 중 ${bad}곳 실패 (씨앗 ${SEEDS.join(',')})`
    : `assign 실시간 수정: 양식 ${specs.length}개 × 씨앗 ${SEEDS.length}개 × ${OPS}번 수정(${total}번) 모두 통과 (씨앗 ${SEEDS.join(',')})`);
  return bad;
}

let code = 0;
try { code = (await main()) ? 1 : 0; }
catch (e) { console.log('FAIL  하네스: ' + e.message); code = 1; }
chrome.kill();
try { rmSync(WORK, { recursive: true, force: true }); } catch { /* 지워지면 그만 */ }
process.exit(code);
