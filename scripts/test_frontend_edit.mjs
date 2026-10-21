// 사전입력·근무표 손 편집 리뷰 반영 (2026-10-21) — node scripts/test_frontend_edit.mjs
// 되돌리기 기록 · 주기 머리줄 키 · 툴팁이 지우던 접근 가능한 이름 · 명부 선택 비우기 · 같은 이름 붙여넣기 ·
// 신호등의 트레이닝 신규 · '야간 N' 열 · 근무표 E→중 · 개발자 비밀번호 초기화의 마스터 · 창의 aria-modal. 이름은 가명.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
for (const f of ['undo-redo', 'drag-select', 'analysis', 'paste-import', 'profiles', 'dev-tools', 'nurse-manage',
  'settings-defs', 'solver', 'view-helpers', 'preinput-io', 'grid-interactions', 'schedule-features',
  'misc-features', 'redesign']) require(`../frontend/js/modules/${f}.js`);
const app = new Function(fs.readFileSync(new URL('../frontend/js/app.js', import.meta.url), 'utf8') + '\nreturn app;')();
const html = fs.readFileSync(new URL('../frontend/index.html', import.meta.url), 'utf8');

const SHIFTS = [['DC', 'day'], ['D', 'day'], ['D1', 'day1'], ['EC', 'evening'], ['E', 'evening'], ['중', 'middle'],
  ['NC', 'night'], ['N', 'night'], ['OF', 'rest'], ['주', 'rest'], ['V', 'leave'], ['생', 'leave'], ['법', 'leave']]
  .map(([code, period]) => ({ code, period }));
const dk = (d, m = 3) => `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function make() {
  const a = app();
  a.year = 2026; a.month = 3; a.shifts = SHIFTS; a.holidays = [];
  a.nurses = [{ id: 'a', name: '간호01' }, { id: 'b', name: '간호02' }];
  a.prevSchedule = {}; a.schedule = {}; a.toasts = [];
  a.toast = (m, t) => { a.toasts.push([m, t]); return a.toasts.length; };
  a.dismissToast = () => {};
  a.$nextTick = (f) => f && f();
  a._queueFeasibility = () => {}; a.rdUndoToast = () => {};
  a.activeTab = 'preinput';
  return a;
}
const key = (k, o = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault() {}, ...o });
// index.html 의 여는 태그 하나 (marker 가 든 태그) · 그 속성 값
const tagOf = (marker) => { const i = html.indexOf(marker); assert.ok(i > 0, marker); return html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1); };
const attrOf = (tag, name) => (tag.match(new RegExp(`\\s${name.replace(/[@:.]/g, '\\$&')}="([^"]*)"`)) || [])[1];
// Alpine 처럼 앱 객체 + x-for 지역 변수 위에서 식을 돌린다
const run = (a, expr, locals) => new Function('a', 'l', `with(a){with(l){${expr}}}`)(a, locals);

// ① 메모·잠금·그날 필요 인원·전월 N 편집도 되돌리기 기록을 남긴다 — 스냅숏엔 들어 있는데 기록이 없어
//    앞 칸을 Ctrl+Z 하면 함께 말없이 지워졌다 (잠금이 풀리면 다음 완화 생성에서 그 칸이 바뀐다)
{
  const a = make();
  a.requirements = { tue: { D: 4, E: 3, N: 2 } };
  const c = a.scheduleDays.findIndex((d) => a.dayKey(d) === dk(3)), day = a.scheduleDays[c];   // 3/3(화)
  a._setSel('preinput', 0, c);
  a.gridKey(key('v'));                                               // 기록 1
  a.openNote('a', day); a.noteEdit.text = '가족 행사'; a.noteEdit.locked = true; a.saveNote();
  const reqTag = tagOf("rdFootNeed(day,row.type)"), pmTag = tagOf("prevMonthNights[nurse.id]||''");
  run(a, attrOf(reqTag, '@change'), { day, row: { type: 'D' }, $event: { target: { value: '3' } } });
  run(a, attrOf(pmTag, '@change'), { nurse: a.nurses[0], $event: { target: { value: '5' } } });
  a.toggleLock('b', day);
  const snap = () => JSON.stringify([a.prevSchedule, a.cellNotes, a.lockedCells, a.prevDayReqs, a.prevMonthNights]);
  assert.equal(snap(), JSON.stringify([{ a: { [dk(3)]: 'V' } }, { a: { [dk(3)]: '가족 행사' } }, { a: { [dk(3)]: true }, b: { [dk(3)]: true } },
    { [dk(3)]: { D: 3 } }, { a: 5 }]));
  const undo = () => a.gridKey(key('z', { ctrlKey: true }));
  undo(); assert.deepEqual(a.lockedCells, { a: { [dk(3)]: true } }, '잠금(팝업)만 되돌린다');
  undo(); assert.deepEqual(a.prevMonthNights, {}, '전월 N 만');
  assert.deepEqual(a.prevDayReqs, { [dk(3)]: { D: 3 } });
  undo(); assert.deepEqual(a.prevDayReqs, {}, '필요 인원만');
  assert.deepEqual(a.cellNotes, { a: { [dk(3)]: '가족 행사' } });
  undo(); assert.deepEqual([a.cellNotes, a.lockedCells], [{}, {}], '메모·잠금');
  assert.deepEqual(a.prevSchedule, { a: { [dk(3)]: 'V' } }, 'V 는 아직 그대로');
  undo(); assert.deepEqual(a.prevSchedule, {});
  a.gridKey(key('y', { ctrlKey: true })); a.gridKey(key('y', { ctrlKey: true }));
  assert.deepEqual([a.cellNotes, a.lockedCells], [{ a: { [dk(3)]: '가족 행사' } }, { a: { [dk(3)]: true } }], '다시 하기도 한 단계씩');
}
// ② 주기 머리줄 키 — 평년 3월은 2월 말 주와 28일 뒤 같은 날짜 주가 함께 있어 '일' 숫자 키가 겹쳤다 (Alpine 중복 키 → 칸이 비거나 어긋남)
{
  const a = make();
  for (const [y, m] of [[2026, 3], [2027, 3], [2028, 3], [2026, 2], [2026, 11]]) {
    a.year = y; a.month = m;
    const spans = a.getCycleSpans(), keys = spans.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length, `${y}-${m} 키 겹침: ${keys}`);
    assert.equal(spans.reduce((t, s) => t + s.count, 0), a.scheduleDays.length, `${y}-${m} 칸 합`);
  }
}
// ③ 커스텀 툴팁 — 포커스 때 title 을 지우면 아이콘 단추·라벨 없는 입력 칸의 이름이 비었다. 이름이 title 뿐이면 aria-label 로,
//    글자가 있는 단추는 말풍선을 설명으로 잇고, 닫으면 넣은 것만 뺀다
{
  class El {
    constructor(tag, attrs = {}, text = '') { this.tagName = tag.toUpperCase(); this.a = { ...attrs }; this.parent = null; this.hidden = false; this.style = {}; this.innerText = text; this.labels = ['input', 'button', 'select'].includes(tag) ? [] : undefined; }
    getAttribute(k) { return k in this.a ? this.a[k] : null; } setAttribute(k, v) { this.a[k] = String(v); }
    removeAttribute(k) { delete this.a[k]; } hasAttribute(k) { return k in this.a; }
    set className(v) { this.a.class = v; } set id(v) { this.a.id = v; } get id() { return this.a.id || ''; }
    closest(sel) { for (let e = this; e; e = e.parent) if (sel.split(',').some((s) => s.slice(1, -1) in e.a)) return e; return null; }
    contains(x) { for (; x; x = x.parent) if (x === this) return true; return false; }
    getBoundingClientRect() { return { left: 0, top: 0, bottom: 10 }; } get offsetWidth() { return 100; } get offsetHeight() { return 20; }
    appendChild(c) { c.parent = this; return c; }
  }
  const L = {}, saved = global.document, savedWin = global.window, ta = make();   // 앱은 모듈이 든 window 로 먼저 만든다
  global.document = { body: new El('body'), createElement: (t) => new El(t), addEventListener: (t, f) => { (L[t] = L[t] || []).push(f); } };
  global.window = { addEventListener() {}, scrollX: 0, scrollY: 0, innerWidth: 1000, innerHeight: 800 };
  let tip = null; const ce = global.document.createElement; global.document.createElement = (t) => (tip = ce(t));
  ta._rdTipInit();
  const name = (e) => e.getAttribute('aria-label') || (e.tagName === 'SELECT' ? '' : e.innerText) || e.getAttribute('title') || '';   // 단순화한 accname
  const close = new El('button', { title: '닫기 (Esc).' });                       // 아이콘만 (svg aria-hidden)
  const need = new El('input', { title: '3/3 D 필요 인원' });                     // 라벨 없는 입력 칸
  const text = new El('button', { title: '이 프로필로 바꿉니다.' }, '전환');         // 글자 단추
  const own = new El('button', { title: '도움말을 엽니다.', 'aria-label': '도움말' });
  const pick = new El('select', { title: '근무를 고릅니다.' }, 'D\nE\nN');           // 보기 글자는 이름이 아니다
  for (const [el, nm, desc] of [[close, '닫기 (Esc).', null], [need, '3/3 D 필요 인원', null], [text, '전환', tip.id], [own, '도움말', tip.id], [pick, '근무를 고릅니다.', null]]) {
    const before = { ...el.a };
    L.focusin.forEach((f) => f({ target: el }));
    assert.equal(el.getAttribute('title'), null, '네이티브 말풍선은 끈다');
    assert.equal(name(el), nm, `포커스 중 이름: ${JSON.stringify(before)}`);
    assert.equal(el.getAttribute('aria-describedby'), desc);
    assert.equal(tip.hidden, false);
    L.focusout.forEach((f) => f({}));
    assert.deepEqual(el.a, before, '닫으면 그대로');
  }
  assert.ok(tip.id, '말풍선에 id');
  global.document = saved; global.window = savedWin;
}
// ④ 명부 선택 비우기 — 고른 사람·Shift 기준·'한 번 더 누르면 지웁니다' 대기까지 (병동 전환이 이 함수를 부른다)
{
  const a = make();
  a.nurses = ['a0', 'a1', 'a2'].map((id, i) => ({ id, name: `간호1${i}` }));
  a.rosterSelDown(0, { button: 0, shiftKey: false, preventDefault() {} }); a.rosterSelOver(1); a._rosterPaint = null;
  const sent = []; a.api = async (m, p) => { sent.push(`${m} ${p}`); return []; }; a.loadNurses = async () => {};
  await a.bulkDelete();                                              // 첫 누름 = 대기
  assert.equal(a._bulkDeleteConfirm, true);
  a.clearNurseSelection();
  assert.deepEqual([a.selectedNurseIds, a._rosterAnchor, a._bulkDeleteConfirm], [[], null, false]);
  a.selectedNurseMap = { a2: true };
  await a.bulkDelete();
  assert.deepEqual(sent, [], '비운 뒤 새로 고른 사람은 다시 한 번 더 눌러야 지운다');
  clearTimeout(a._bulkDeleteTimer);
}
// ⑤ 같은 이름 붙여넣기 — 명부에 같은 이름이 둘이면 두 줄이 모두 뒤 사람에게 들어가고 앞 줄은 버려졌다.
//    같은 이름(명부에 둘 이상·붙인 표에 여러 줄)은 이름으로 맞추지 않고 '이름 맞추기'에서 줄마다 고른다
{
  const a = make();
  a.nurses = [{ id: 'a0', name: '간호01' }, { id: 'a1', name: '간호01' }, { id: 'a2', name: '간호03' }];
  a.openPastePrev('prev');
  a.pastePrev.rawText = '이름\t1\t2\n간호01\tV\tV\n간호01\tD\tE\n간호03\tN\tN'; a.onPasteTextChange();
  const rows = a.pasteNameRows;
  assert.deepEqual(rows.map((x) => [x.name, x.matched]), [['간호01', false], ['간호01', false]], '같은 이름 두 줄은 고르게 한다');
  assert.notEqual(rows[0].mapKey, rows[1].mapKey);
  assert.deepEqual(a.pastePrev.diff.will_set.map((x) => x.nid), ['a2', 'a2'], '간호03 은 그대로 맞춘다');
  a.setPasteName(rows[0].mapKey, 'a1');
  assert.deepEqual(a.pasteNameChoices(rows[1].name, rows[1].mapKey).map((n) => n.id), ['a0'], '다른 줄이 맞춘 사람(앞 줄 a1·간호03 a2)은 빼고');
  a.setPasteName(a.pasteNameRows[1].mapKey, 'a0');
  a.applyPastePrev();
  assert.deepEqual(a.prevSchedule, { a1: { [dk(1)]: 'V', [dk(2)]: 'V' }, a0: { [dk(1)]: 'D', [dk(2)]: 'E' }, a2: { [dk(1)]: 'N', [dk(2)]: 'N' } });
  // 명부엔 한 명인데 붙인 표에 두 줄 — 한 사람에 두 줄이 덮이지 않게 둘 다 고르게 한다
  const b = make();
  b.openPastePrev('prev');
  b.pastePrev.rawText = '이름\t1\n간호01\tD\n간호02\tE\n간호01\tN'; b.onPasteTextChange();
  assert.deepEqual(b.pasteNameRows.map((x) => x.name), ['간호01', '간호01']);
  assert.deepEqual(b.pastePrev.diff.will_set.map((x) => `${x.nid}${x.newShift}`), ['bE']);
}
// ⑥ 신호등 '인원이 모자라는 날' — 트레이닝 중인 신규는 인원이 아니다 (엔진·분석 탭과 같다). 예전엔 부족한 날이 '여유 0'
{
  const a = make();
  a.nurses = [...['r1', 'r2', 'r3', 'r4', 'r5'].map((id) => ({ id, name: id })),
    ...['t1', 't2'].map((id) => ({ id, name: id, is_trainee: true, training_end_date: dk(31) }))];
  a.requirements = { tue: { D: 2, E: 2, N: 2 } };
  a.prevSchedule = { r5: { [dk(3)]: 'V' } };
  a._checkStaffingSlack();
  assert.deepEqual(a.staffingAlerts.short.find((x) => x.dk === dk(3)), { dk: dk(3), needed: 6, avail: 4 });
}
// ⑦ 사전입력 '야간 N' 열(이달 야간 입력 수) — 다른 달 사전입력의 N 까지 세어 이달 2회가 8로 보였다
{
  const a = make();
  a.year = 2026; a.month = 11;
  a.prevSchedule = { a: Object.fromEntries([[dk(5, 10), 'N'], [dk(6, 10), 'N'], [dk(7, 10), 'NC'], [dk(12, 10), 'N'], [dk(13, 10), 'N'], [dk(14, 10), 'N'],
    [dk(10, 11), 'N'], [dk(11, 11), 'NC'], [dk(12, 11), 'OF'], [dk(1, 12), 'N']]) };
  assert.equal(a.countPrevNights('a'), 2);
}
// ⑧ 근무표 손 수정 위반 — 엔진의 하드 금지 9종(_transition_rules) 그대로. E→중·EC→중 이 빠졌고, N→중·N→D1 은 N→E·N→D 로 찍혔다
{
  const a = make();
  const at = (pairs) => { a.schedule = { a: {} }; pairs.forEach((c, i) => { a.schedule.a[dk(i + 1)] = c; }); a.checkScheduleViolations(); return a.scheduleViolations.map((v) => v.msg.match(/\(([^)]+)\)$/)[1]); };
  assert.deepEqual(at(['E', '중']), ['E→중']);
  assert.deepEqual(at(['EC', '중']), ['E→중']);
  assert.deepEqual(at(['N', '중', 'OF', 'NC', 'D1']), ['N→중', 'N→D1']);
  assert.deepEqual(at(['E', 'D', 'OF', 'N', 'E', 'OF', 'N', 'DC', '중', 'D1']), ['E→D', 'N→E', 'N→D', '중→D1']);
  assert.deepEqual(at(['E', 'D1', 'OF', '중', 'D']), [], 'E→D1·중→D 는 마지막 수단 — 파트장 확인으로 (제1원칙 13)');
  a.rules.rareTransitionLastResort = false;
  assert.deepEqual(at(['E', 'D1', 'OF', '중', 'D']), ['E→D1', '중→D']);
}
// ⑨ 개발자 설정 '프로필 비밀번호 초기화' — 마스터 비밀번호가 있으면 함께 보낸다 (없이 보내 늘 403), 오류는 detail 만
{
  const a = make();
  a.profiles = [{ id: 'p1', name: '병동1' }];
  const sent = [];
  a.api = async (m, p, body) => { sent.push(body); if (body.master_password !== 'mpw') throw new Error('{"detail":"마스터 비밀번호가 필요합니다."}'); return { ok: true }; };
  a._loadProfiles = async () => {};
  global.confirm = () => true;
  a.hasMasterPassword = true;
  await a.devResetProfilePassword('p1');
  assert.deepEqual([sent.length, a.toasts.at(-1)[1]], [0, 'error'], '마스터 비밀번호 칸이 비면 보내지 않는다');
  a.devResetMasterPw = 'x';
  await a.devResetProfilePassword('p1');
  assert.deepEqual(a.toasts.at(-1), ['마스터 비밀번호가 필요합니다.', 'error'], 'JSON 원문 대신 detail');
  a.devResetMasterPw = 'mpw';
  await a.devResetProfilePassword('p1');
  assert.deepEqual(sent.at(-1), { id: 'p1', old_password: '', new_password: '', force_reset: true, master_password: 'mpw' });
  assert.equal(a.devResetMasterPw, '', '성공하면 칸을 비운다');
  assert.ok(attrOf(tagOf('x-model="devResetMasterPw"'), 'x-show').includes('hasMasterPassword'), '개발자 설정 창에 마스터 비밀번호 칸');
  delete global.confirm;
}
// ⑩ 화면을 덮는 창은 모두 role=dialog aria-modal — 표는 보이는 aria-modal 창이 있으면 키를 받지 않는다(_gridKeysOn).
//    프로필 전환·개발자 설정·프로필 만들기·비밀번호 변경·온보딩 창이 빠져 뒤 표가 D·Del·Ctrl+V 를 받았다
{
  const overlays = [...html.matchAll(/<div\b[^>]*:style="[^"]*\?'position:fixed;inset:0[^>]*>/g)].map((m) => m[0])
    .filter((t) => !t.includes('profile-overlay'));                 // 프로필 고르기 화면은 창이 아니라 첫 화면 (표 키는 profileScreen 이 막는다)
  assert.ok(overlays.length >= 5, String(overlays.length));
  for (const t of overlays) assert.ok(/role="dialog"/.test(t) && /aria-modal="true"/.test(t) && /aria-label="[^"]+"/.test(t), t.slice(0, 90));
  const a = make(); const c0 = a.scheduleDays.findIndex((d) => a.dayKey(d) === dk(1));
  a._setSel('preinput', 0, c0);
  global.document = { body: {}, activeElement: null, addEventListener() {}, querySelector: () => null, getElementById: () => null };
  global.document.activeElement = global.document.body;
  global.document.querySelectorAll = (q) => (q.includes('aria-modal') ? overlays.filter((t) => t.includes('aria-modal="true"') && t.includes('profileSwitchModal')).map(() => ({ getClientRects: () => [1] })) : []);
  assert.equal(a._gridKeysOn(), false, '프로필 전환 창이 열려 있으면 표는 키를 받지 않는다');
}
// ⑪ 메뉴 '전월 야간 수 계산'(autoFillPrevMonthNights)도 되돌리기 기록 — 없으면 앞 칸 Ctrl+Z 가 가져온 전월 N 을 말없이 지웠다
{
  const a = make();
  a._setSel('preinput', 0, a.scheduleDays.findIndex((d) => a.dayKey(d) === dk(3)));
  a.gridKey(key('v'));
  let linted = 0; a._checkViolations = () => { linted++; };
  a.api = async () => ({ a: 5 });
  await a.autoFillPrevMonthNights();
  assert.deepEqual([a.prevMonthNights, linted], [{ a: 5 }, 1], '가져온 뒤 라인트(2개월 야간 합산)도 다시 본다');
  const undo = () => a.gridKey(key('z', { ctrlKey: true }));
  undo(); assert.deepEqual([a.prevMonthNights, a.prevSchedule], [{}, { a: { [dk(3)]: 'V' } }], '전월 N 만 되돌린다');
  undo(); assert.deepEqual(a.prevSchedule, {});
}
console.log('test_frontend_edit: OK');
