// 붙여넣기 날짜 해석(멀티월) 자가검증 — node scripts/test_paste_dates.mjs
// paste-import.js의 _parseDateCell / _resolveHeaderDates 순수 로직만 검증한다
// (그리드 매칭·적용은 앱 상태가 필요하므로 브라우저에서 확인).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

globalThis.window = {};
eval(readFileSync(new URL('../frontend/js/modules/paste-import.js', import.meta.url), 'utf8'));
const mod = window.PasteImportModule();

const parse = (s) => mod._parseDateCell(s);
const resolve = (cells, y, m) =>
  mod._resolveHeaderDates(cells.map((c) => (typeof c === 'string' ? parse(c) : c)), y, m);

// ── _parseDateCell ──
assert.deepEqual(parse('5/26'), { y: null, m: 5, d: 26 });
assert.deepEqual(parse('5월 26일'), { y: null, m: 5, d: 26 });
assert.deepEqual(parse('5.26'), { y: null, m: 5, d: 26 });
assert.deepEqual(parse('2026-05-26'), { y: 2026, m: 5, d: 26 });
assert.deepEqual(parse('2026년 5월 26일'), { y: 2026, m: 5, d: 26 });
assert.deepEqual(parse('26일'), { y: null, m: null, d: 26 });
assert.deepEqual(parse('26'), { y: null, m: null, d: 26 });
assert.deepEqual(parse('1(월)'), { y: null, m: null, d: 1 });
assert.deepEqual(parse('5/26(화)'), { y: null, m: 5, d: 26 });
assert.equal(parse('13/40'), null);   // 월 13 없음
assert.equal(parse('32'), null);      // 일 32 없음
assert.equal(parse('요일'), null);
assert.equal(parse(''), null);

// ── _resolveHeaderDates: 월 명시 ──
// 주기 이월 표 (5월 말 + 6월) — copyScheduleTsv/병동 시트 형식
assert.deepEqual(
  resolve(['5/26', '5/27', '6/1', '6/2'], 2026, 6),
  ['2026-05-26', '2026-05-27', '2026-06-01', '2026-06-02'],
);
// 월 명시 + 일자만 이어짐 (감소 = 다음 달)
assert.deepEqual(
  resolve(['5/30', '31', '1', '2'], 2026, 6),
  ['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02'],
);
// 첫 명시 월 앞의 일자만 셀 → 역방향 (증가 = 이전 달)
assert.deepEqual(
  resolve(['30', '31', '6/1', '2'], 2026, 6),
  ['2026-05-30', '2026-05-31', '2026-06-01', '2026-06-02'],
);
// 연도 경계: 앵커에 가장 가까운 해 선택
assert.deepEqual(resolve(['12/31', '1/1'], 2026, 1), ['2025-12-31', '2026-01-01']);
assert.deepEqual(resolve(['12/31', '1/1'], 2025, 12), ['2025-12-31', '2026-01-01']);
// 연도 명시는 그대로
assert.deepEqual(resolve(['2025-12-31'], 2026, 6), ['2025-12-31']);
// 실존하지 않는 날짜는 무효
assert.deepEqual(resolve(['2/30'], 2026, 2), [null]);
// 인식 불가 셀이 섞여도 자리 유지
assert.deepEqual(resolve(['5/26', '요일', '5/27'], 2026, 5), ['2026-05-26', null, '2026-05-27']);

// ── _resolveHeaderDates: 일자만 (run 분리) ──
// 단일 run 1~31 = 앵커 월 (기존 동작 유지)
assert.deepEqual(resolve(['1', '2', '3'], 2026, 7), ['2026-07-01', '2026-07-02', '2026-07-03']);
// 이월형: 26~31 | 1~... — 1로 시작하는 run이 앵커, 앞 run은 이전 달
assert.deepEqual(
  resolve(['26', '31', '1', '2'], 2026, 6),
  ['2026-05-26', '2026-05-31', '2026-06-01', '2026-06-02'],
);
// 여러 달 연속: 1~30 | 1~31 — 첫 1-시작 run이 앵커, 뒤 run은 다음 달
assert.deepEqual(
  resolve(['1', '30', '1', '31'], 2026, 6),
  ['2026-06-01', '2026-06-30', '2026-07-01', '2026-07-31'],
);
// 12월 → 1월 연도 넘김
assert.deepEqual(
  resolve(['30', '31', '1', '2'], 2026, 1),
  ['2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02'],
);
// 월 중간 부분 표 (1-시작 run 없음) → 첫 run이 앵커 월
assert.deepEqual(resolve(['15', '16'], 2026, 6), ['2026-06-15', '2026-06-16']);

// ── _parseSheetNameYM (멀티시트 일괄 업로드의 시트 이름 → 년월) ──
const sheetYM = (s) => mod._parseSheetNameYM(s);
assert.deepEqual(sheetYM('2026년 1월'), { y: 2026, m: 1 });
assert.deepEqual(sheetYM('26년 1월'), { y: 2026, m: 1 });
assert.deepEqual(sheetYM('2026-1'), { y: 2026, m: 1 });
assert.deepEqual(sheetYM('2026.12'), { y: 2026, m: 12 });
assert.deepEqual(sheetYM('1월'), { y: null, m: 1 });
assert.deepEqual(sheetYM('12월 근무표'), { y: null, m: 12 });
assert.deepEqual(sheetYM('3'), { y: null, m: 3 });
assert.deepEqual(sheetYM('2026'), { y: 2026, m: null });
assert.equal(sheetYM('통계'), null);
assert.equal(sheetYM('명단'), null);
assert.equal(sheetYM('13월'), null);   // 월 13 없음
assert.equal(sheetYM(''), null);

// ── _parseFileNameYear (파일 이름 → 연도) ──
const fileY = (s) => mod._parseFileNameYear(s);
assert.equal(fileY('26년 번표.xlsx'), 2026);
assert.equal(fileY('2026 번표.xlsx'), 2026);
assert.equal(fileY('번표_2025.xlsx'), 2025);
assert.equal(fileY('번표.xlsx'), null);

console.log('test_paste_dates: 모든 검증 통과');

// ── _normalizeShiftCode: 병동 번표 표기 (2026-10-03, 101병동) ──
mod.shifts = ['DC','D','D1','EC','E','중','NC','N','OF','주','P1','V','생','특','공','법','병','경가','조가','산전']
  .map((code) => ({ code }));
const norm = (s) => mod._normalizeShiftCode(s);
assert.equal(norm('OFF'), 'OF');
assert.equal(norm('Off'), 'OF');
assert.equal(norm('off'), 'OF');
assert.equal(norm('v'), 'V');
assert.equal(norm('특V'), '특');
assert.equal(norm('특v'), '특');
assert.equal(norm('공가'), '공');
assert.equal(norm('경가'), '경가');
assert.equal(norm('조가'), '조가');
assert.equal(norm('산전'), '산전');
assert.equal(norm('경사휴가'), '경가');
assert.equal(norm('조사휴가'), '조가');
assert.equal(norm('산전검진'), '산전');
mod.shifts = mod.shifts.filter((s) => s.code !== '경가');
assert.equal(norm('경사휴가'), undefined);   // 근무 정의에 없으면 모르는 표기
// 원티드 '둘 중 하나'·'N 빼고' (제1원칙 14) — 엔진 _PRE_ALIAS 와 같은 표기
for (const [raw, code] of [['D/E', 'D/E'], ['E/D', 'D/E'], ['de', 'D/E'], ['E/N', 'E/N'], ['N/E', 'E/N'],
  ['EN', 'E/N'], ['DN', 'D/N'], ['N/D', 'D/N'], ['d/n', 'D/N'], ['N제외', 'N제외'], ['N 제외', 'N제외'], ['N빼고', 'N제외']])
  assert.equal(norm(raw), code, raw);
assert.equal(norm('D/X'), undefined);
console.log('paste-dates: 병동 표기 정규화 통과');

// ── 병동 번표 시트 그대로 올리기 (2026-10-17, 실제 병동 번표 형식 — 이름은 가명) ──
// 제목(병합이 칸마다 퍼진다)·주기 줄이 날짜 위에, 요일 줄 오른쪽엔 집계 머리, 아래엔 날마다 센 인원 줄.
// 예전엔 첫 줄(제목 '…(10월 4일~…)')을 날짜로 읽어 한 달이 하루로 접혔고, 인원 줄이 '명부에 없는 이름'으로 떴다.
mod.shifts = ['DC','D','D1','EC','E','중','NC','N','OF','주','P1','V','생','특','공','법','병','경가','조가','산전']
  .map((code) => ({ code }));
Object.assign(mod, {
  nurses: [{ id: 'a', name: '간호01' }, { id: 'b', name: '간호02' }],
  prevSchedule: {},
  scheduleDays: [],
  isOverflow: () => false,
  dayKey: (d) => d.toISOString().slice(0, 10),
  _cycleDateKeys: () => new Set(),
});
{
  const title = '2026년 10월 번표(10월 4일~ 10월 31일)';
  const grid = [
    Array(9).fill(title),
    ['', '4주기', '4주기', '4주기', '1주기', '1주기', '1주기', '1주기'],
    ['', ...[1, 2, 3, 4, 5, 6, 7].map((d) => `2026-10-0${d}`)],
    ['', '목', '금', '토', '일', '월', '화', '수', 'D', 'E', 'N', 'OF', '총근무'],
    ['간호01', 'D', 'E', 'N', 'OF', '주', '/D', 'D', '3', '1', '1', '1', '5'],
    ['간호02 ', 'N', 'N', 'OF', 'OF', 'D', 'D', '특V', '2', '0', '2', '2', '4'],
    ['퇴사자', 'D', 'D', 'D', 'D', 'D', 'D', 'D', '7', '0', '0', '0', '7'],
    ['D', '2', '1', '0', '0', '2', '1', '2'],
    ['근무자수', '3', '3', '1', '0', '3', '2', '2'],
    ['E차치', '1', '1', '0', '0', '0', '0', '0'],
  ];
  const r = mod._matchGrid(grid, { anchorY: 2026, anchorM: 10, mode: 'auto', target: 'saved' });
  assert.equal(r.best.headerR, 2);
  assert.equal(r.best.dateFrom, '2026-10-01');
  assert.equal(r.best.dateTo, '2026-10-07');
  assert.deepEqual(r.diff.unmatchedNames, ['퇴사자']);
  assert.deepEqual(r.diff.unrecognized, []);
  assert.equal(r.diff.matched_all.length, 14);
  assert.equal(new Set(r.diff.matched_all.map((x) => x.dk)).size, 7);
  assert.equal(r.diff.matched_all.find((x) => x.nid === 'a' && x.dk === '2026-10-06').code, '/D');
  assert.equal(r.diff.matched_all.find((x) => x.nid === 'b' && x.dk === '2026-10-07').code, '특');
}
// 첫 줄이 날짜인 붙여넣기는 예전 그대로
{
  const r = mod._matchGrid([['', '1', '2', '3'], ['간호01', 'D', 'E', 'N']],
    { anchorY: 2026, anchorM: 10, mode: 'auto', target: 'prev' });
  assert.equal(r.best.headerR, 0);
  assert.deepEqual(r.diff.matched_all.map((x) => x.dk + x.code), ['2026-10-01D', '2026-10-02E', '2026-10-03N']);
}
// 신규 트레이닝 날 표기
assert.equal(norm('/D'), '/D');
assert.equal(norm('/off'), '/OF');
assert.equal(norm('/V'), '/V');
// 올린 번표의 나이트킵: 그 달 근무가 전부 N 이고 10회 넘으면 저장본 명부에만 적는다 (제1원칙 7)
{
  const sched = { a: {}, b: {} };
  for (let d = 1; d <= 28; d++) {
    const dk = `2026-10-${String(d).padStart(2, '0')}`;
    sched.a[dk] = d % 2 ? 'N' : 'OF';                     // N 14
    sched.b[dk] = d % 4 === 0 ? 'N' : d % 4 === 1 ? 'D' : 'OF';   // N 7 + D
  }
  sched.a['2026-11-01'] = 'D';                             // 다른 달 근무는 세지 않는다
  const ns = mod._uploadNurses(sched, 2026, 10);
  assert.deepEqual(ns[0].night_months, { '2026-10': true });
  assert.equal(ns[1], mod.nurses[1]);
  assert.equal(mod.nurses[0].night_months, undefined);     // 명부는 그대로
}
console.log('paste-dates: 병동 번표 시트 올리기 통과');

// ── 지난달 표 이어오기: 1일 앞 지난달 칸까지 (11월이면 10/25~10/31) ──
eval(readFileSync(new URL('../frontend/js/modules/schedule-features.js', import.meta.url), 'utf8'));
{
  const sf = window.ScheduleFeaturesModule();
  const keys = new Set();
  for (let t = Date.UTC(2026, 9, 25); t <= Date.UTC(2026, 11, 5); t += 864e5) keys.add(new Date(t).toISOString().slice(0, 10));
  Object.assign(sf, {
    year: 2026, month: 11, prevSchedule: { a: { '2026-11-03': 'V' } },
    _cycleDateKeys: () => keys, _pushUndo() {}, toast() {},
    async api(_m, p) {
      return p === '/api/schedules' ? [{ id: 7, year: 2026, month: 10 }]
        : { data: { schedule: { a: { '2026-10-10': 'E', '2026-10-25': 'D', '2026-10-31': 'N' } } } };
    },
  });
  await sf.loadPrevMonthSchedule();
  assert.deepEqual(sf.prevSchedule.a, { '2026-11-03': 'V', '2026-10-25': 'D', '2026-10-31': 'N' });
}
console.log('paste-dates: 지난달 표 이어오기 통과');
