// 근무 시간으로 근무 사이 휴식을 잰다 (결정 1-92) — node scripts/test_shift_hours.mjs
// 서버(tests/test_shift_hours.py)와 같은 입력에 같은 쌍·같은 라벨이 나와야 한다. 근무 정의 창은 보탠 근무에 시작·끝 시각을 받는다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] };
global.EventSource = class { close() {} };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();
const BASE = [['DC', 'day', '06:00~14:00'], ['D', 'day', '06:00~14:00'], ['D1', 'day1', '08:30~17:30'], ['EC', 'evening', '14:00~22:00'], ['E', 'evening', '14:00~22:00'],
  ['중', 'middle', '11:00~19:00'], ['NC', 'night', '22:00~06:00'], ['N', 'night', '22:00~06:00'], ['OF', 'rest', '-'], ['주', 'rest', '-'], ['V', 'leave', '-']];
const ADDED = [['중3', 'middle', '09:00~18:00'], ['D3', 'day', '12:00~21:00'], ['E2', 'evening', '16:00~24:00']];
const make = (added = ADDED) => { const a = app(); a.shifts = [...BASE, ...added].map(([code, period, hours]) => ({ code, period, hours, name: code })); a.toast = (m) => { a._toast = m; }; return a; };
const pairs = (a) => Object.fromEntries(a.hoursTransitionRules().map(r => [r[0][0] + '>' + r[1][0], r[2]]));

// 시간 읽기 — 서버 parse_shift_hours 와 같게
{
  const a = make();
  assert.deepEqual(a.parseShiftHours('06:00~14:00'), [360, 840]); assert.deepEqual(a.parseShiftHours('22:00~06:00'), [1320, 1800]);
  assert.deepEqual(a.parseShiftHours('16:00~24:00'), [960, 1440]); assert.deepEqual(a.parseShiftHours(' 9:00 - 18:00 '), [540, 1080]);
  for (const bad of ['', '-', null, '오전', '25:00~26:00', '09:00']) assert.equal(a.parseShiftHours(bad), null);
}
// 보탠 근무가 낀 쌍만 · 휴식이 모자란 것만 · 역순 9종이 하드로 막는 쌍은 겹치지 않게
{
  const p = pairs(make());
  assert.equal(p['D3>D'], 'D3→D, 휴식 9시간'); assert.ok(p['D3>DC']); assert.equal(p['D3>D1'], undefined);
  assert.equal(p['E2>D1'], 'E2→D1, 휴식 8.5시간');
  assert.equal(p['E2>D'], undefined); assert.equal(p['E2>중3'], undefined); assert.equal(p['N>중3'], undefined); assert.equal(p['E>D1'], undefined);
  assert.ok(Object.keys(p).every(k => /중3|D3|E2/.test(k)));
  assert.deepEqual(make([]).hoursTransitionRules(), []);
  const off = make(); off.rules.minRest = false; assert.deepEqual(off.hoursTransitionRules(), []);
  const eight = make(); eight.rules.minRestHours = 8; assert.equal(pairs(eight)['D3>D'], undefined);
  const twelve = make(); twelve.rules.minRestHours = 12; assert.ok(pairs(twelve)['D3>D1']);
  assert.deepEqual(pairs(make([['D3', 'day', '']])), {}, '시간이 없으면 잴 수 없다');
}
// 근무표의 위반 표시 — 손으로 고쳐 D3 다음 날 D 를 넣으면 걸린다. 기본 근무끼리는 전과 같다
{
  const a = make(); a.year = 2026; a.month = 12; a.nurses = [{ id: 'x', name: '간호01' }, { id: 'y', name: '간호02' }];
  a.schedule = { x: { '2026-12-08': 'D3', '2026-12-09': 'D' }, y: { '2026-12-08': 'D3', '2026-12-09': 'D1', '2026-12-10': 'E', '2026-12-11': 'D1' } };
  a.checkScheduleViolations();
  assert.equal(a.scheduleViolations.length, 1); assert.match(a.scheduleViolations[0].msg, /간호01.*D3→D, 휴식 9시간/);
}
// 근무 정의 창 — 보탠 근무는 시작·끝 시각이 있어야 저장된다. 쉬는 코드는 시간 칸이 없다
{
  const a = make([]); const sent = []; a.api = async (m, p, body) => { sent.push(body); return {}; }; a.loadShifts = async () => {};
  a.openShiftModal(null); Object.assign(a.shiftModal.data, { code: '중3', name: '중간번3', period: 'middle' });
  await a.saveShift(); assert.equal(sent.length, 0); assert.match(a._toast, /시작·끝 시각/); assert.equal(a.shiftModal.open, true);
  a.setShiftHoursPart(0, '09:00'); assert.equal(a.shiftModal.data.hours, '', '하나만 넣으면 아직 비어 있다'); assert.equal(a.shiftHoursPart(0), '09:00');
  a.setShiftHoursPart(1, '18:00'); assert.equal(a.shiftModal.data.hours, '09:00~18:00');
  assert.match(a.shiftHoursHint, /11시간보다 짧으면 그 전환을 막습니다.*근무 9시간/);
  await a.saveShift(); assert.equal(sent.length, 1); assert.equal(sent[0].hours, '09:00~18:00'); assert.equal(a.shiftModal.open, false);
  a.openShiftModal(null); Object.assign(a.shiftModal.data, { code: '연수', name: '연수', period: 'leave' });
  await a.saveShift(); assert.equal(sent[1].hours, '-');
  a.openShiftModal({ code: 'N', name: 'Night', period: 'night', hours: '22:00~06:00' });
  assert.deepEqual([a.shiftHoursPart(0), a.shiftHoursPart(1)], ['22:00', '06:00']); assert.match(a.shiftHoursHint, /기본 근무끼리.*자정을 넘깁니다/);
  assert.equal(a.shiftNeedsHours({ code: '중3', period: 'middle', hours: '' }), true); assert.equal(a.shiftNeedsHours({ code: 'D1', period: 'day1', hours: '' }), false);
  // 서버가 거절하면 창을 닫지 않고 이유를 보인다
  a.api = async () => { throw new Error('근무 시간을 넣어 주세요'); };
  a.openShiftModal({ code: '중3', name: '중간번3', period: 'middle', hours: '09:00~18:00' }); await a.saveShift();
  assert.equal(a.shiftModal.open, true); assert.match(a._toast, /근무 시간/);
}
console.log('test_shift_hours: OK');
