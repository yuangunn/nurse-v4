// 신규간호사 트레이닝 날 검증 — node scripts/test_trainee_days.mjs
// 마지막 트레이닝 날 = 트레이닝 끝나는 날과 생성 범위 안 '/' 사전입력 중 늦은 날 (엔진 trainee_last_day 와 같은 규칙).
// 그 다음 날부터 보통 간호사다 — 달 중간에 독립하면 그 뒤는 칸 수·인원·주의 목록에 센다 (2026-10-16, 101병동 11월).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();

const SHIFTS = [
  ['DC', 'day'], ['D', 'day'], ['D1', 'day1'], ['EC', 'evening'], ['E', 'evening'], ['중', 'middle'],
  ['NC', 'night'], ['N', 'night'], ['OF', 'rest'], ['주', 'rest'], ['V', 'leave'], ['법', 'leave'],
].map(([code, period]) => ({ code, period }));
const dk = (d) => `2026-03-${String(d).padStart(2, '0')}`;
const day = (d) => new Date(2026, 2, d);

// 간호01 = 프리셉터, 간호09 = 신규 (3/3 에 트레이닝 끝)
function make({ end = '2026-03-03', prev = {}, rows = {}, rules = {} } = {}) {
  const a = app();
  a.year = 2026; a.month = 3;
  a.shifts = SHIFTS;
  a.holidays = [];
  a.nurses = [
    { id: 'p1', name: '간호01' },
    { id: 't9', name: '간호09', is_trainee: true, training_end_date: end, preceptor_id: 'p1' },
  ];
  a.prevSchedule = prev;
  a.schedule = {};
  for (const [id, codes] of Object.entries(rows)) {
    a.schedule[id] = {};
    codes.forEach((c, i) => { if (c) a.schedule[id][dk(i + 1)] = c; });
  }
  Object.assign(a.rules, rules);
  return a;
}

// ── 마지막 트레이닝 날 ──
let a = make();
const t9 = () => a.nurses[1];
assert.equal(a.traineeLastKey(a.nurses[0]), '');
assert.equal(a.traineeLastKey(t9()), '2026-03-03');
assert.equal(a.isTraineeInTraining(t9(), day(3)), true);
assert.equal(a.isTraineeInTraining(t9(), day(4)), false);
//  · 끝나는 날 뒤에 '/E' 로 넣은 날까지 트레이닝, 생성 범위 밖 '/' 는 보지 않는다
a = make({ prev: { t9: { [dk(5)]: '/E', [dk(2)]: '주', '2026-06-01': '/D' } } });
assert.equal(a.traineeLastKey(t9()), '2026-03-05');
assert.equal(a.isTraineeInTraining(t9(), day(5)), true);
assert.equal(a.isTraineeInTraining(t9(), day(6)), false);
//  · 끝나는 날이 없으면 계속 트레이닝
a = make({ end: null });
assert.equal(a.traineeLastKey(t9()), '9999-12-31');
assert.equal(a.isTraineeInTraining(t9(), day(31)), true);

// ── 칸 수 — 신규는 트레이닝 날만 뺀다 (3월 31일 + 독립한 28일) ──
a = make();
assert.equal(a.rdCells, 31 + 28);
assert.match(a.stepperSummary.preinput, / \/ 59 셀$/);
a = make({ end: null });
assert.equal(a.rdCells, 31);
a = make({ end: '2026-02-20' });
assert.equal(a.rdCells, 62);

// ── 분석의 인원 — 트레이닝 날엔 세지 않고, 독립한 날부터 센다 ──
a = make();
const res = a._analyzeStaffing();
const byKey = Object.fromEntries(res.days.map((x) => [x.dk, x]));
assert.equal(byKey[dk(3)].freeNurses, 1, JSON.stringify(byKey[dk(3)]));
assert.equal(byKey[dk(4)].freeNurses, 2, JSON.stringify(byKey[dk(4)]));

// ── 상태 줄 — 트레이닝 날 '/E' 를 넣었는데 프리셉터가 D 였다 = 바뀐 칸, '모두 지켰어요'라 하지 않는다 ──
a = make({
  prev: { t9: { [dk(1)]: 'OF', [dk(2)]: '/E', [dk(3)]: '/E', [dk(6)]: '주' } },
  rows: { p1: ['D', 'DC', 'EC', 'D', 'D', 'D', 'OF'], t9: ['OF', '/DC', '/EC', 'D', 'E', '주', 'N'] },
});
assert.equal(a.rdTraineeChanged, 1);                      // 3/2 만 — 3/3 '/EC' 는 차지 표시만 다르다
assert.match(a.rdStatus.text, /사전입력 3칸 지켰어요 · 신규 트레이닝 날 1칸은 프리셉터 근무를 따랐어요/);
//  · 엔진이 원티드 미반영으로 이미 알린 칸(relaxed_cells)은 두 번 세지 않는다
a.relaxedCells = { t9: { [dk(2)]: { original: '/E', assigned: '/DC', is_timeoff: false } } };
assert.equal(a.rdTraineeChanged, 0);
a.relaxedCells = {};
a.prevSchedule.t9[dk(2)] = '/D';
assert.equal(a.rdTraineeChanged, 0);
assert.match(a.rdStatus.text, /사전입력 4칸 모두 지켰어요/);

// ── 주의 — 트레이닝 날('/D')도 그날 일한 것: 독립한 첫날들과 이어 센다 ──
a = make({ rows: { t9: ['/D', '/D', '/E', 'E', 'E', 'N', 'OF'] } });
let w = a.scheduleWarnings;
assert.equal(w.length, 1, JSON.stringify(w));
assert.equal(w[0].type, 'check');
assert.match(w[0].msg, /3\/1~3\/6 연속 6일 근무/);
//  · 트레이닝 날 안에서 끝나는 연속은 프리셉터 쪽 일 (신규 줄에 띄우지 않는다)
a = make({ end: '2026-03-07', rows: { t9: ['/D', '/D', '/E', '/E', '/E', '/N', 'OF', 'D'] } });
assert.deepEqual(a.scheduleWarnings, [], JSON.stringify(a.scheduleWarnings));
//  · 마지막 트레이닝 날 '/E' → 독립한 첫날 D1 = E→D1 (파트장 확인)
a = make({ rows: { t9: ['OF', '/D', '/E', 'D1', 'OF'] } });
w = a.scheduleWarnings;
assert.equal(w.length, 1, JSON.stringify(w));
assert.match(w[0].msg, /3\/3 E → 3\/4 D1 \(E→D1\) — 파트장 확인 필요/);
//  · 프리셉터가 넣은 E(그대로)와 신규가 넣은 D1 — 둘 다 사람이 넣은 사실이라 세지 않는다
a = make({ prev: { p1: { [dk(3)]: 'E' }, t9: { [dk(3)]: '/E', [dk(4)]: 'D1' } },
  rows: { p1: ['D', 'D', 'E', 'OF'], t9: ['OF', '/D', '/E', 'D1', 'OF'] } });
assert.deepEqual(a.scheduleWarnings, [], JSON.stringify(a.scheduleWarnings));
//  · 프리셉터 E 를 엔진이 놓았으면 신규의 '/E' 사전입력이 있어도 센다 (엔진 manager_check 와 같게)
delete a.prevSchedule.p1;
assert.equal(a.scheduleWarnings.length, 1, JSON.stringify(a.scheduleWarnings));

console.log('test_trainee_days: OK');
