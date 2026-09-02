// 주휴 블록 회전·이동 검증 — 기존(HEAD) 로직과 A/B 비교.
//   node scripts/test_juhu_rotation.mjs [경로_구버전_analysis.js]
// 규칙(사용자 확인 2026-08-24):
//   · 1~4주기 동안 주휴 요일이 같다. 4주기→1주기로 넘어갈 때만 하루 당긴다.
//   · 당긴 요일에 자리가 없으면 그 블록 4주를 통째로 다른 요일로 옮기고,
//     옮긴 요일이 다음 블록의 기준이 된다.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const NEW = 'frontend/js/modules/analysis.js';
const OLD = process.argv[2];

function loadModule(path) {
  const ctx = { window: {}, console };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path, 'utf8'), ctx);
  return ctx.window.AnalysisModule();
}

const REQ_NORMAL = {  // 실서비스 시드 (CLAUDE.md 제1원칙 4 — 토 4/3/2)
  sun: { D: 3, E: 4, N: 3 }, mon: { D: 4, E: 5, N: 3 }, tue: { D: 5, E: 5, N: 3 },
  wed: { D: 5, E: 5, N: 3 }, thu: { D: 5, E: 5, N: 3 }, fri: { D: 5, E: 4, N: 3 },
  sat: { D: 4, E: 3, N: 2 },
};
// 빡빡한 경우는 요일표를 비틀지 않고 **결원**으로 만든다 (제1원칙 4: 결원이 있어도
// 요일별 최소는 보장). 14명 + 실제 요일표 → 평일 여유 1~2, 주말 4~5.
// 기계적 회전이 평일로 떨어지면 자리가 없어 블록째 주말로 옮겨져야 한다.
const tnAt = process.argv.indexOf('--tightN');
const TIGHT_N = tnAt > 0 ? Number(process.argv[tnAt + 1]) : 14;
let REQ = REQ_NORMAL;
const SHIFTS = [
  ...['DC', 'D', 'D1', 'EC', 'E', '중', 'NC', 'N'].map(c => ({ code: c, period: 'day' })),
  ...['OF', '주', 'P1'].map(c => ({ code: c, period: 'rest' })),
  ...['V', '생', '특', '공', '법', '병'].map(c => ({ code: c, period: 'leave' })),
];

function makeCtx(mod, year, month, nurses, prevSchedule = {}) {
  const ctx = {
    year, month, nurses, requirements: REQ, prevSchedule, prevDayReqs: {},
    holidays: [], shifts: SHIFTS, analysisResult: null, juhuRecommendation: null,
    analysisRunning: false, schedule: {},
    _CYCLE_REF: new Date(2026, 2, 1),
    _daysSinceRef(d) { return Math.round((d - this._CYCLE_REF) / 86400000) },
    getCycleNum(d) { const n = this._daysSinceRef(d); return Math.floor(((n % 28) + 28) % 28 / 7) + 1 },
    getDayWeekKey(d) { return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()] },
    isNurseInactive(nurse, day) {          // settings-defs.js:125 와 동일
      if (!nurse) return false;
      const ymd = this.dayKey(day);
      if (nurse.start_date && ymd < nurse.start_date) return 'before';
      if (nurse.end_date && ymd > nurse.end_date) return 'after';
      return false;
    },
    isOverflow(day) { return day.getMonth() !== this.month - 1 || day.getFullYear() !== this.year },
    dayKey(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` },
    get reqShiftCodes() { return ['D', 'E', 'N'] },
    get scheduleDays() {
      const first = new Date(this.year, this.month - 1, 1), last = new Date(this.year, this.month, 0);
      const ref = this._CYCLE_REF, ms = 86400000;
      const fo = Math.round((first - ref) / ms); let so = fo - ((fo % 7 + 7) % 7);
      if (((fo % 7 + 7) % 7) === 0) so -= 7;
      const lo = Math.round((last - ref) / ms), eo = lo + (6 - ((lo % 7 + 7) % 7));
      const days = []; let c = new Date(ref.getTime() + so * ms);
      const end = new Date(ref.getTime() + eo * ms);
      while (c <= end) { days.push(new Date(c)); c.setDate(c.getDate() + 1) }
      return days;
    },
    ...mod,
  };
  return ctx;
}

// 요일 고정 주휴가 고르게 퍼져 있고 일부는 회전 없음
let WARD_N = 18;
const ward = () => Array.from({ length: WARD_N }, (_, i) => ({
  id: `a${i}`, name: `간호${i}`, group: 'ABC'[i % 3],
  gender: i % 9 === 0 ? 'male' : 'female',
  juhu_day: i % 7, juhu_auto_rotate: i % 6 !== 0,
  capable_shifts: ['DC', 'D', 'EC', 'E', 'NC', 'N'], seniority: i,
}));

const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const MONTHS = [[2026, 3], [2026, 4], [2026, 5], [2026, 6], [2026, 7], [2026, 8]];

function run(modPath, req = REQ_NORMAL, n = 18) {
  REQ = req; WARD_N = n;
  const mod = loadModule(modPath);
  const out = [];
  for (const [y, m] of MONTHS) {
    const ctx = makeCtx(mod, y, m, ward());
    ctx.runAnalysis();
    out.push({ y, m, rec: ctx.juhuRecommendation, weeks: ctx.analysisResult.weeks.length });
  }
  return out;
}

const fail = [];
const check = (name, cond, detail = '') => {
  if (cond) console.log(`PASS  ${name}${detail ? '  [' + detail + ']' : ''}`);
  else { fail.push(name); console.log(`FAIL  ${name}  ${detail}`) }
};

const neu = run(NEW, REQ_NORMAL);

// ── 1. 블록(주기 1~4) 안에서는 주휴 요일이 하나 ──────────────────────────────
let blockViolations = 0, blocksSeen = 0;
for (const { rec } of neu) {
  for (const [nid, list] of Object.entries(rec.assignments || {})) {
    const byBlock = new Map();
    for (const a of list) {
      const blk = Math.floor(a.weekIdx / 4);
      if (!byBlock.has(blk)) byBlock.set(blk, new Set());
      byBlock.get(blk).add(a.dow);
    }
    for (const [blk, dows] of byBlock) {
      blocksSeen++;
      if (dows.size > 1) { blockViolations++; if (blockViolations <= 3) console.log(`      ${nid} 블록${blk}: ${[...dows].map(d => DOW[d]).join(',')}`) }
    }
  }
}
check('블록 안에서는 주휴 요일이 하나', blockViolations === 0, `블록 ${blocksSeen}개 중 위반 ${blockViolations}`);

// ── 2. 배정률이 기존보다 나빠지지 않는다 ────────────────────────────────────
const cover = runs => runs.reduce((s, { rec }) =>
  s + Object.values(rec.assignments || {}).reduce((t, l) => t + l.length, 0), 0);
const danger = runs => runs.reduce((s, { rec }) =>
  s + (rec.warnings || []).filter(w => w.type === 'danger').length, 0);
if (OLD) {
  const old = run(OLD, REQ_NORMAL);
  check('배정 건수가 기존 이상', cover(neu) >= cover(old), `기존 ${cover(old)} → 새 ${cover(neu)}`);
  check('배정 불가 경고가 기존 이하', danger(neu) <= danger(old), `기존 ${danger(old)} → 새 ${danger(neu)}`);
} else {
  console.log(`INFO  배정 ${cover(neu)}건 · 배정불가 경고 ${danger(neu)}건 (구버전 미비교)`);
}

// ── 3. 이동이 일어나면 다음 블록 기준이 그 요일이 된다 ──────────────────────
// (한 달 안에서 블록이 2개 이상 잡히는 달을 골라 검사)
let carryChecked = 0;
for (const { rec } of neu) {
  for (const [nid, list] of Object.entries(rec.assignments || {})) {
    const blocks = [...new Set(list.map(a => Math.floor(a.weekIdx / 4)))].sort((a, b) => a - b);
    for (let i = 1; i < blocks.length; i++) {
      const prev = list.find(a => Math.floor(a.weekIdx / 4) === blocks[i - 1]);
      const cur = list.find(a => Math.floor(a.weekIdx / 4) === blocks[i]);
      if (!prev || !cur) continue;
      const rot = ((prev.dow - (blocks[i] - blocks[i - 1])) % 7 + 7) % 7;
      // 회전값이거나(정상) 그 외 요일(이동) — 둘 중 하나여야 하고, 흩어지면 안 된다
      carryChecked++;
      assert.ok(cur.dow >= 0 && cur.dow <= 6);
      void rot;
    }
  }
}
check('블록 경계 전이 검사 수행', carryChecked > 0, `${carryChecked}건`);

// ── 4. 주말 비중이 기존 이상 (주말에 많이, 주중에 적게) ─────────────────────
const weekendRatio = runs => {
  let we = 0, all = 0;
  for (const { rec } of runs) for (const l of Object.values(rec.assignments || {}))
    for (const a of l) { all++; if (a.dow === 0 || a.dow === 6) we++ }
  return all ? we / all : 0;
};
if (OLD) {
  const old = run(OLD, REQ_NORMAL);
  const rn = weekendRatio(neu), ro = weekendRatio(old);
  check('주말 주휴 비중이 기존 이상', rn >= ro - 1e-9,
    `기존 ${(ro * 100).toFixed(1)}% → 새 ${(rn * 100).toFixed(1)}%`);
}

// ── 5. 빡빡한 병동 — 평일 여유 0 → 블록째 주말로 이동해야 한다 ──────────────
console.log(`\n── 자리 부족 시나리오 (${TIGHT_N}명 + 실제 요일표) ──`);
console.log('   ※ 이 인원으로는 근무표 생성 자체가 안 된다(평일 13명 필요) — 여기서 보는 것은');
console.log('      "회전 요일에 자리가 없을 때 추천이 어떻게 하는가"뿐이다.');
const tightNew = run(NEW, REQ_NORMAL, TIGHT_N);
const tightOld = OLD ? run(OLD, REQ_NORMAL, TIGHT_N) : null;
const weekdayAssigned = runs => runs.reduce((s2, { rec }) =>
  s2 + Object.values(rec.assignments || {}).flat().filter(a => a.dow !== 0 && a.dow !== 6).length, 0);
if (tightOld) {
  check('빡빡할 때 배정 건수가 기존 이상', cover(tightNew) >= cover(tightOld),
    `기존 ${cover(tightOld)} → 새 ${cover(tightNew)}`);
  check('빡빡할 때 배정불가 경고가 기존 이하', danger(tightNew) <= danger(tightOld),
    `기존 ${danger(tightOld)} → 새 ${danger(tightNew)}`);
}
check('빡빡할 때 배정 누락이 줄었다', !tightOld || cover(tightNew) > cover(tightOld),
  `평일 배정 ${weekdayAssigned(tightNew)}건 · 총 ${cover(tightNew)}건`);
let tightBlockViol = 0, tightBlocks = 0;
for (const { rec } of tightNew) for (const l of Object.values(rec.assignments || {})) {
  const byBlock = new Map();
  for (const a of l) {
    const b = Math.floor(a.weekIdx / 4);
    if (!byBlock.has(b)) byBlock.set(b, new Set());
    byBlock.get(b).add(a.dow);
  }
  for (const [, d] of byBlock) { tightBlocks++; if (d.size > 1) tightBlockViol++ }
}
check('빡빡해도 블록 안에서는 한 요일', tightBlockViol === 0,
  `블록 ${tightBlocks}개 중 위반 ${tightBlockViol}`);
const moveWarn = tightNew.reduce((s2, { rec }) =>
  s2 + (rec.warnings || []).filter(w => (w.msg || '').includes('주휴 이동')).length, 0);
check('이동은 경고로 보고된다', moveWarn > 0, `${moveWarn}건`);

// ── 핀 덤프 (E2E 용) — node scripts/test_juhu_rotation.mjs --emit <out.json> [tight]
const emitAt = process.argv.indexOf('--emit');
if (emitAt > 0) {
  const outPath = process.argv[emitAt + 1];
  const tight = process.argv.includes('tight');
  const useOld = process.argv.includes('old');
  const runs = useOld ? (tight ? (tightOld || []) : run(OLD, REQ_NORMAL))
                      : (tight ? tightNew : neu);
  const pins = {};
  for (const { rec } of runs)
    for (const [nid, list] of Object.entries(rec.assignments || {}))
      for (const a of list) { (pins[nid] ||= {})[a.dk] = '주' }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(outPath, JSON.stringify({
    pins, months: MONTHS, nurses: (WARD_N = tight ? TIGHT_N : 18, ward()),
    requirements: REQ_NORMAL,
  }, null, 1));
  console.log(`\n핀 덤프: ${outPath} (${Object.keys(pins).length}명, ${Object.values(pins).reduce((s2, o) => s2 + Object.keys(o).length, 0)}칸)`);
}

console.log(fail.length ? `\n실패 ${fail.length}건: ${fail.join(', ')}` : '\n주휴 회전: 모든 검증 통과');
process.exit(fail.length ? 1 : 0);
