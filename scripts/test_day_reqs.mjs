// 날짜별 필요 인원 역산 — node scripts/test_day_reqs.mjs
// '이 표대로 인원 고정'(applyReqFromPrev)·재조정(_reqFromSchedule)은 칸이 다 찬 날만 센다.
// 엔진이 끝에 붙은 다음 달 며칠의 날짜별 인원도 걸게 되어(결정 1-47), 원티드 몇 칸만 있는 날을 세면
// 그 적은 수가 그날 필요 인원으로 고정돼 생성이 막히거나 그날이 거의 비었다. 이름은 가명.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {} };
global.confirm = () => true;
require('../frontend/js/modules/settings-defs.js');
require('../frontend/js/modules/schedule-features.js');
require('../frontend/js/modules/preinput-io.js');

const dk = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const nurses = [{ id: 'a', name: '간호01' }, { id: 'b', name: '간호02' }, { id: 'c', name: '간호03', end_date: '2026-12-02' }];
const ctx = { year: 2026, month: 11, nurses, dayKey: dk, toasts: [], toast(m) { this.toasts.push(m) },
  prevDayReqs: {}, isFlexWish: () => false, _pushUndo() {}, _checkViolations() {}, _queueFeasibility() {} };
for (const mod of [window.SettingsDefsModule(), window.ScheduleFeaturesModule(), window.PreinputIoModule()])
  Object.defineProperties(ctx, Object.getOwnPropertyDescriptors(mod));

// 11/30 = 셋 다 참 · 12/02 = 간호03 빈칸 · 12/03 = 간호03 전출 뒤라 둘이면 다 참
const sched = {
  a: { '2026-11-30': 'D', '2026-12-02': 'N', '2026-12-03': 'E' },
  b: { '2026-11-30': 'E', '2026-12-02': 'OF', '2026-12-03': 'DC' },
  c: { '2026-11-30': 'NC' },
};
assert.equal(ctx._dayColumnFull(sched, '2026-11-30', nurses), true);
assert.equal(ctx._dayColumnFull(sched, '2026-12-02', nurses), false);
assert.equal(ctx._dayColumnFull(sched, '2026-12-03', nurses), true);

// 재조정 역산 — 다 찬 날만
assert.deepEqual(ctx._reqFromSchedule(sched), {
  '2026-11-30': { D: 1, E: 1, N: 1 }, '2026-12-03': { D: 1, E: 1, N: 0 } });
// 명부에 없는 줄(올리기에서 맞춘 사람만 든 표)도 그 줄 기준으로 본다
assert.deepEqual(Object.keys(ctx._reqFromSchedule({ x: { '2026-11-30': 'D' } })), ['2026-11-30']);

// '이 표대로 인원 고정' — 다 찬 날만 고정하고 빈칸 있는 날은 건너뛴다
ctx.prevSchedule = sched;
ctx.applyReqFromPrev();
assert.deepEqual(Object.keys(ctx.prevDayReqs).sort(), ['2026-11-30', '2026-12-03']);
assert.deepEqual(ctx.prevDayReqs['2026-11-30'], { D: 1, E: 1, N: 1 });
// 다 찬 날이 하나도 없으면 아무것도 고정하지 않고 알린다
ctx.prevDayReqs = {};
ctx.prevSchedule = { a: { '2026-12-02': 'N' } };
ctx.applyReqFromPrev();
assert.deepEqual(ctx.prevDayReqs, {});
assert.match(ctx.toasts.at(-1), /칸이 다 찬 날이 없습니다/);

console.log('day-reqs: 모든 검증 통과');
