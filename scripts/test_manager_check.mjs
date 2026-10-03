// 파트장 확인 필요 표시 검증 — node scripts/test_manager_check.mjs
// 제1원칙 13 (2026-10-03): 연속 근무 한도+1 · E→D1 · 중→D 는 근무표가 정 안 나올 때만 쓰는
// 마지막 수단이다. 서랍 '주의'(scheduleWarnings)가 '파트장 확인 필요'로 맨 위에 보여야 하고,
// 표의 위반 표시(checkScheduleViolations)에는 넣지 않는다 — 규칙 위반이 아니라 확인할 일이다.
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

function make(rows, rules = {}) {
  const a = app();
  a.year = 2026; a.month = 3;
  a.shifts = SHIFTS;
  a.holidays = ['2026-03-02'];
  a.nurses = Object.keys(rows).map((id) => ({ id, name: '간호' + id }));
  a.schedule = {};
  for (const [id, codes] of Object.entries(rows)) {
    a.schedule[id] = {};
    codes.forEach((c, i) => { if (c) a.schedule[id][`2026-03-${String(i + 1).padStart(2, '0')}`] = c; });
  }
  Object.assign(a.rules, rules);
  return a;
}

// 3/1(일) 주 · 3/2(공휴일)~3/7(토) 6일 연속 → 파트장 확인 (주말·공휴일 2일)
let a = make({ '01': ['주', 'D', 'D', 'E', 'E', 'N', 'N', 'OF'] });
let w = a.scheduleWarnings;
assert.equal(w.length, 1, JSON.stringify(w));
assert.equal(w[0].type, 'check');
assert.match(w[0].msg, /3\/2~3\/7 연속 6일 근무 \(주말·공휴일 2일 포함\) — 파트장 확인 필요/);

// 끄면 한도 초과 주의 (손으로 고친 뒤와 같다)
a = make({ '01': ['주', 'D', 'D', 'E', 'E', 'N', 'N', 'OF'] }, { longRunLastResort: false });
w = a.scheduleWarnings;
assert.equal(w[0].type, 'warn');
assert.match(w[0].msg, /연속 6일 근무 \(한도 5일\)/);

// 7일 연속은 마지막 수단 범위 밖 — 늘 한도 초과
a = make({ '01': ['D', 'D', 'D', 'E', 'E', 'N', 'N', 'OF'] });
assert.equal(a.scheduleWarnings[0].type, 'warn');

// E→D1 · 중→D 는 파트장 확인, 맨 위로
a = make({
  '01': ['주', 'D', 'E', 'OF', 'D', 'D', 'D', 'D', 'D', 'D', 'D', 'D'],   // 7일 연속(한도 초과) — 뒤로
  '02': ['E', 'D1', 'OF', '중', 'D', 'OF'],
});
w = a.scheduleWarnings;
assert.deepEqual(w.map((x) => x.type), ['check', 'check', 'warn'], JSON.stringify(w));
assert.match(w[0].msg, /3\/1 E → 3\/2 D1 \(E→D1\) — 파트장 확인 필요/);
assert.match(w[1].msg, /3\/4 중 → 3\/5 D \(중→D\) — 파트장 확인 필요/);

// 표의 위반 표시는 E→D 만 (E→D1·중→D 는 확인할 일이지 위반이 아니다)
a = make({ '02': ['E', 'D1', 'OF', '중', 'D', 'E', 'D'] });
a.checkScheduleViolations();
assert.deepEqual(a.scheduleViolations.map((v) => v.dk), ['2026-03-07'], JSON.stringify(a.scheduleViolations));
assert.match(a.scheduleViolations[0].msg, /\(E→D\)/);
a.rules.rareTransitionLastResort = false;
a.checkScheduleViolations();
assert.deepEqual(a.scheduleViolations.map((v) => v.dk), ['2026-03-02', '2026-03-05', '2026-03-07']);

console.log('test_manager_check: OK');
