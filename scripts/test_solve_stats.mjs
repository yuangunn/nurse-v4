// 계산 현황(솔버 기록 해석)·결과 요약 단계 검증 — node scripts/test_solve_stats.mjs
// HiGHS 기록 줄을 읽어 숫자 카드와 시간순 사건을 만든다 (redesign.js _solveFeed). 한 메시지에 여러 줄이 올 수 있고,
// 화면에 남기는 원본 기록(solverLogs)은 최근 200줄로 잘려도 읽은 숫자는 남는다.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
global.window = {};
global.localStorage = { getItem: () => null, setItem() {} };
require('../frontend/js/modules/redesign.js');
const f = Object.defineProperties({}, Object.getOwnPropertyDescriptors(window.RedesignModule()));
Object.assign(f, { solverLogs: [], _logSeq: 0, _scrollLogs() {}, solveProgress: {} });

const row = (src, proc, q, lv, ex, bound, sol, gap, cuts, inlp, confl, lp, t) =>
  ` ${src || ' '} ${String(proc).padStart(7)} ${String(q).padStart(7)} ${String(lv).padStart(9)} ${ex.padStart(7)}   ${String(bound).padEnd(15)} ${String(sol).padEnd(18)} ${gap.padStart(6)} ${String(cuts).padStart(8)} ${String(inlp).padStart(6)} ${String(confl).padStart(6)} ${String(lp).padStart(9)} ${String(t).padStart(7)}s`;
// 풀이 #1 — 한 메시지에 여러 줄 (서버는 메시지 끝만 다듬는다)
f._pushLog('Presolving model\n22766 rows, 7414 cols, 104818 nonzeros  0s\n15097 rows, 6834 cols, 86232 nonzeros  0s');
f._pushLog('\nSolving MIP model with:\n   15097 rows\n   6834 cols (6834 binary, 0 integer, 0 implied int., 0 continuous)');
f._pushLog('        Nodes      |    B&B Tree     |            Objective Bounds              |  Dynamic Constraints |       Work      \nSrc  Proc. InQueue |  Leaves   Expl. | BestBound       BestSol              Gap |   Cuts   InLp Confl. | LpIters     Time');
f._pushLog(row('', 0, 0, 0, '0.00%', -267000, 'inf', 'inf', 0, 0, 0, 0, 0.2));
assert.equal(f.rdSolveCards.find(c => c.k === '지금 표 점수').v, '—');
f._pushLog(row('L', 0, 0, 0, '0.00%', -254500, -253000, '0.59%', 5991, 381, 212, 54589, 32.3));
f._pushLog('\n24.2% inactive integer columns, restarting\nModel after restart has 12271 rows, 4885 cols (4885 bin., 0 int., 0 impl., 0 cont.), and 65112 nonzeros');
f._pushLog(row('', 142, 111, 16, '3.13%', -254500, -253000, '0.59%', 7876, 246, 308, 220764, 59.0));   // 같은 해 — 사건 아님
f._pushLog(row('T', 498, 0, 95, '99.99%', -254500, -254500, '0.00%', 10257, 293, 1184, 394491, 97.1));
f._pushLog('Solving report\n  Status            Optimal\n  Primal bound      -254500');
// 풀이 #2 — 앞에서 찾은 해로 시작
f._pushLog('Presolving model\n22782 rows, 7431 cols, 106113 nonzeros  0s\n15242 rows, 6884 cols, 89572 nonzeros  0s\n\nMIP start solution is feasible, objective value is 5465');
f._pushLog('Solving MIP model with:\n   15242 rows');
f._pushLog(row('', 0, 0, 0, '0.00%', -33185, 5465, '707.23%', 0, 0, 0, 0, 0.2));            // 시작 해 그대로 — 사건 아님
f._pushLog(row('L', 101, 10, 31, '0.05%', '-4578.52102', -3155, '45.12%', 3615, 301, 479, 216551, 78.3));
f._pushLog('힌트 한 줄', true);                                                              // 힌트는 읽지 않는다

const S = f.solveStats;
assert.deepEqual(S.phases.map(p => [p.n, p.rows0, p.rows, p.cols0, p.cols, p.restarts, p.status]),
  [[1, 22766, 15097, 7414, 6834, 1, 'Optimal'], [2, 22782, 15242, 7431, 6884, 0, '']]);
assert.deepEqual(S.events.map(e => `${e.solve}|${e.time}|${e.text}`), [
  '1|0|조건 정리 — 따질 조건 22,766개를 15,097개로 줄임',
  '1|32.3|첫 표를 찾음 — 작은 문제로 쪼개 풀기',
  '1|32.3|문제를 줄여 다시 시작 — 더 볼 필요 없는 칸 24.2%를 걷어 냄 (조건 12,271개)',
  '1|97.1|더 좋은 표를 찾음 — 갈래를 평가하다가',
  '1|97.1|끝 — 가장 좋은 표로 확인됨',
  '2|0|앞 단계에서 찾은 표로 시작',
  '2|0|조건 정리 — 따질 조건 22,782개를 15,242개로 줄임',
  '2|78.3|더 좋은 표를 찾음 — 작은 문제로 쪼개 풀기',
]);
assert.deepEqual(S.events.map(e => [e.sol, e.gap]).slice(1, 4), [['253,000', '0.59%'], ['253,000', '0.59%'], ['254,500', '0.00%']]);   // 점수 = 솔버 값의 부호를 뒤집은 것
assert.equal(f.rdSolveEvents[0].text, '더 좋은 표를 찾음 — 작은 문제로 쪼개 풀기');          // 새 것이 위
// 카드는 쉬운 말 — 솔버 기록의 이름은 툴팁에만
assert.deepEqual(f.rdSolveCards.map(c => `${c.k}=${c.v}`), ['따져 본 경우=101', '아직 남은 경우=10', '쳐낸 경우=31', '살펴본 비율=0.05%',
  '지금 표 점수=3,155', '가능한 최고 점수=4,579', '최고와의 차이=45.12%', '방금 표를 찾은 방법=작은 문제로 쪼개 풀기']);
assert.match(f.rdSolveCards[0].tip, /Proc\./);
assert.equal(f.rdSolveSub, '2번째 풀이 · 따질 조건 22,782개를 15,242개로 정리 · 새로 찾아 더한 규칙 3,615개 · 막힌 데서 배운 것 479개 · 계산 216,551번');
assert.ok(f.rdSolveCards.every(c => c.tip));
assert.equal(f.solverLogs.length, 14);
assert.equal(f.solverLogs.at(-1).hint, true);

// 원본 기록이 200줄로 잘려도 읽은 숫자는 남는다
for (let i = 0; i < 320; i++) f._pushLog(row('', 200 + i, 5, 40, '1.00%', '-4500', -3155, '40.00%', 1, 1, 1, 300000 + i, 80 + i));
assert.ok(f.solverLogs.length <= 300);
assert.equal(f.rdSolveCards[0].v, '519');
assert.equal(S.events.length, 8);

// 소문자 Src (z·l·u·p — 자명한 해) 줄도 읽는다
f._pushLog(row('z', 520, 5, 40, '1.00%', '-4500', -3200, '39.00%', 1, 1, 1, 400000, 500));
assert.equal(S.events.at(-1).text, '더 좋은 표를 찾음 — 가장 단순한 값으로');

// 큰 수는 솔버가 k·M 을 붙여 줄여 적는다 — 그 줄도 읽어야 카드가 계속 바뀐다 (실제 기록: 계산 횟수가 2237k 가 된 뒤로 카드가 멈췄다)
f._pushLog('    1775      28       278  79.18%   -3478.805352    -3358              3.60%     4996    447   9199     2476k   712.5s');
assert.deepEqual(f.rdSolveCards.map(c => c.v).slice(0, 7), ['1,775', '28', '278', '79.18%', '3,358', '3,479', '3.60%']);
f._pushLog('    12.5k   1.2k      3.4k  80.00%   -3470           -3358              3.33%     5000    450   10.1k    1.25M   900.0s');
assert.deepEqual([f.rdSolveCards[0].v, f.rdSolveCards[1].v, f.rdSolveCards[2].v], ['12,500', '1,200', '3,400']);
assert.match(f.rdSolveSub, /막힌 데서 배운 것 10,100개 · 계산 1,250,000번/);

// HiGHS 기록이 아니면(CP-SAT) 진행 정보의 노드·Gap 만
f._solveReset(); f._pushLog('#1       0.52s best:1200  next:[900,1100]  no_lp');
assert.deepEqual(f.rdSolveCards, []);
f.solveProgress = { nodes: 1520, gap_percent: 3.456 };
assert.deepEqual(f.rdSolveCards.map(c => `${c.k}=${c.v}`), ['따져 본 경우=1,520', '가능한 최고와의 차이=3.46%']);

// 결과 요약 단계 — 계산 → 지킨 것 → (바꾼 것) → (확인할 것) → 결과. 없는 장은 건너뛴다
f._solveReset();
for (const l of ['Presolving model', '100 rows, 50 cols, 300 nonzeros  0s', '80 rows, 40 cols, 200 nonzeros  0s', 'Solving MIP model with:', row('H', 12, 0, 5, '100.00%', -10, -10, '0.00%', 3, 2, 1, 900, 75.4), '  Status            Optimal']) f._solveFeed(l);
for (const [k, v] of [['rdSched', true], ['rdRelaxedCount', 0], ['rdTraineeChanged', 0], ['rdWantedCount', 40], ['rdWantedRelaxed', 0]]) Object.defineProperty(f, k, { value: v, writable: true });   // 계산 속성을 값으로
Object.assign(f, { mipGapPercent: 0, scheduleStopped: false, generationReport: { duration_seconds: 75.4 }, rdSaved: true,
  scheduleDays: [new Date(2026, 11, 1), new Date(2026, 11, 2)], isOverflow: () => false,
  footerRows: [{ label: 'D', shifts: ['DC', 'D'] }, { label: 'E', shifts: ['EC', 'E'] }, { label: 'N', shifts: ['NC', 'N'] }, { label: '휴무', shifts: ['OF'] }],
  got: { D: 5, E: 5, N: 3 }, getDayDutyCount(d, shifts) { return this.got[shifts[1]] ?? 0; }, rdFootNeed: (d, c) => ({ D: 5, E: 5, N: 3 })[c],
  scheduleWarnings: [], offTeukgeun: [], vReport: null, wishReport: null });
assert.deepEqual(f.rdStorySteps.map(s => s.id), ['calc', 'kept', 'done']);
assert.equal(f.rdStorySteps[0].title, '경우 12가지를 따져 봤어요');
assert.deepEqual(f.rdStorySteps[0].facts, [['걸린 시간', '1분 15초'], ['풀이 횟수', '1번'], ['따져 본 경우', '12가지'], ['더 볼 필요 없어 쳐낸 경우', '5가지'],
  ['계산 횟수', '900번'], ['따질 조건 정리', '100개 → 80개'], ['마지막 표를 찾은 방법', '어림 탐색'], ['끝난 까닭', '가장 좋은 표로 확인됨'], ['가능한 최고와의 차이', '0%']]);
assert.equal(f.rdStorySteps[1].title, '원티드 40칸을 모두 지켰어요');
assert.deepEqual(f.rdStorySteps[1].facts.at(-1), ['날마다 필요 인원 (D·E·N)', '모두 채움']);
f.got.E = 4; assert.equal(f.rdStorySteps[1].facts.at(-1)[1], '2곳 모자람'); f.got.E = 5;   // 이틀 × E
f.rdRelaxedCount = 3; f.rdWantedRelaxed = 3; f.scheduleWarnings = [{ type: 'check' }, { type: 'info' }]; f.offTeukgeun = [{}]; f.vReport = { total: 2 };
assert.deepEqual(f.rdStorySteps.map(s => s.id), ['calc', 'kept', 'changed', 'check', 'done']);
assert.equal(f.rdStorySteps[1].title, '원티드 40칸 중 37칸을 지켰어요');
f.rdWantedRelaxed = 1;                                                    // 바뀐 3칸 중 둘은 주휴·지난달 칸 — 원티드로 세지 않는다
assert.equal(f.rdStorySteps[1].title, '원티드 40칸 중 39칸을 지켰어요'); f.rdWantedRelaxed = 3;
assert.deepEqual(f.rdStorySteps[3].facts.map(x => x.slice(1)), [['1건', 'warn'], ['1건', 'teukgeun'], ['2건', 'v']]);
// 넘기기 — 마지막 장에서 다음을 누르면 닫힌다
f.rdStoryOpen(); assert.deepEqual(f.story, { open: true, step: 0 });
f.rdStoryGo(-1); assert.equal(f.story.step, 0);
for (let i = 0; i < 4; i++) f.rdStoryGo(1);
assert.deepEqual([f.story.open, f.story.step, f.rdStoryStep.id], [true, 4, 'done']);
f.rdStoryGo(1); assert.equal(f.story.open, false);
// 중간에 닫으면 다시 여는 자리를 알린다 (끝 장에서 닫으면 알리지 않는다)
const said = []; f.toast = (m) => said.push(m); global.setTimeout = () => 0;
f.rdStoryOpen(); f.rdStoryGo(1); f.rdStoryClose();
assert.deepEqual([f.story.open, f.storyHint, said.length], [false, true, 1]);
f.rdStoryOpen(); assert.equal(f.storyHint, false);
for (let i = 0; i < 4; i++) f.rdStoryGo(1);
f.rdStoryClose(); assert.deepEqual([f.story.open, f.storyHint, said.length], [false, false, 1]);
f.rdSched = false; assert.deepEqual(f.rdStorySteps, []);

// 칸별 이유 — 이 칸만 원래 사전입력으로 두고 다른 바뀐 칸은 풀어 둔 채 정밀 진단에 보낸다
{
  const g = Object.defineProperties({}, Object.getOwnPropertyDescriptors(window.RedesignModule()));
  let sent = null, reply = { status: 'feasible', conflicts: [], muses: [], message: '충돌 없음' };
  Object.assign(g, { cellWhy: {}, offTeukgeun: [], managerCheck: [],
    prevSchedule: { a: { '2026-12-25': 'V', '2026-12-26': 'D제외', '2026-12-10': 'OF' }, b: { '2026-12-31': 'OF' } },
    relaxedCells: { a: { '2026-12-25': { original: 'V', assigned: 'D' }, '2026-12-26': { original: 'D제외', assigned: 'DC' } }, b: { '2026-12-31': { original: 'OF', assigned: 'E' } } },
    _diagPayload() { return { year: 2026, month: 12, prev_schedule: this.prevSchedule, unlimited_v: false }; },
    api: async (m, url, body) => { sent = { m, url, body }; return reply; } });
  assert.equal(g.rdCellWhyView('a', '2026-12-25'), null);
  const run = g.rdCellWhy('a', '2026-12-25');
  assert.equal(g.rdCellWhyView('a', '2026-12-25').state, 'loading');
  await run;
  assert.deepEqual([sent.m, sent.url, sent.body.year, sent.body.unlimited_v], ['POST', '/api/diagnose', 2026, false]);
  assert.deepEqual(sent.body.prev_schedule, { a: { '2026-12-25': 'V', '2026-12-10': 'OF' }, b: {} });   // 이 칸은 원래 값, 다른 바뀐 칸은 비움, 지킨 칸은 그대로
  assert.deepEqual(g.prevSchedule.a['2026-12-26'], 'D제외');                                              // 화면의 사전입력은 건드리지 않는다
  assert.equal(g.rdCellWhyView('a', '2026-12-25').state, 'free');
  reply = { status: 'infeasible', conflicts: ['12/31 D 필요 인원 5명', '나 5주차 OF 1회'], muses: [['12/31 D 필요 인원 5명'], ['나 5주차 OF 1회']],
    anchored: [{ label: '12/31 D 필요 인원 5명', nurse_id: null, date: '2026-12-31' }] };
  await g.rdCellWhy('b', '2026-12-31');
  const v = g.rdCellWhyView('b', '2026-12-31');
  assert.deepEqual([v.state, v.soft, v.groups.map((x) => x.map((c) => [c.label, c.date]))], ['blocked', false, [[['12/31 D 필요 인원 5명', '2026-12-31']], [['나 5주차 OF 1회', null]]]]);
  g.offTeukgeun = [{}]; assert.equal(g.rdCellWhyView('b', '2026-12-31').soft, true);
  reply = { status: 'timeout', conflicts: [], muses: [], message: '충돌 분석 미완료 (타임아웃).' };
  await g.rdCellWhy('a', '2026-12-26');
  assert.deepEqual([g.rdCellWhyView('a', '2026-12-26').state, g.rdCellWhyView('a', '2026-12-26').message], ['unknown', '충돌 분석 미완료 (타임아웃).']);
  g.api = async () => { throw new Error('연결 끊김'); };
  await g.rdCellWhy('a', '2026-12-25');
  assert.equal(g.rdCellWhyView('a', '2026-12-25').message, '계산하지 못했습니다 — 연결 끊김');
  await g.rdCellWhy('a', '2026-01-01'); assert.equal(g.rdCellWhyView('a', '2026-01-01'), null);          // 바뀐 칸이 아니면 아무것도 안 한다
}

// 다시 만들기가 실패하면 앞 표가 떠 있어도 실패 배너·상태 줄로 알린다 — 숨기면 단추가 먹지 않은 것처럼 보였다
{
  const g = Object.defineProperties({}, Object.getOwnPropertyDescriptors(window.RedesignModule()));
  for (const [k, v] of [['rdSched', true], ['rdPreChanged', true], ['rdRelaxedCount', 0], ['rdTraineeChanged', 0], ['rdWantedCount', 10]]) Object.defineProperty(g, k, { value: v, writable: true });
  Object.assign(g, { generating: false, statusOk: false, statusMessage: '근무표 생성 실패 - 원인 진단 결과:\n  [원인] 일별 인원 제약 충돌', genFailed: false,
    staffingAlerts: { short: [], tight: [] }, diagResult: null, feas: null, nurses: [], prevSchedule: {}, countPrevEntries: () => 10, analysisResult: null });
  assert.equal(g.rdFail, null);                                   // 경고가 붙은 성공(statusOk=false) — 표가 있으면 배너 없음
  assert.equal(g.rdStatus.changed, true);
  g.genFailed = true;                                             // 방금 다시 만들기가 실패
  assert.match(g.rdFail.title, /^이 조건으로는 만들 수 없어요/);
  assert.match(g.rdFail.body, /아래 표는 다시 만들기 전에 만든 표 그대로입니다\.$/);
  assert.deepEqual([g.rdStatus.kind, g.rdStatus.failed, g.rdStep.s3], ['err', true, '다시 만들기 실패']);
  g.rdSched = false;                                              // 표가 없으면 예전처럼 배너만
  assert.ok(g.rdFail && !/아래 표는/.test(g.rdFail.body)); assert.equal(g.rdStatus, null);
  // 완화를 켜고도 실패 — 완화로 풀 수 있는 칸(잠그지 않은 OF)은 원인이 아니다. 엄격 기준의 인원 부족·신호등은 쓰지 않는다
  g.staffingAlerts = { short: [{ dk: '2026-12-31', needed: 12, avail: 11 }], tight: [] };
  g.feas = { status: 'infeasible', summary: '엄격 기준 요약', anchored: [{ label: 'x', nurse_id: 'a', date: '2026-12-26' }] };
  g._staffingSlack = (fixedOnly) => ({ short: fixedOnly ? [] : g.staffingAlerts.short, tight: [] });
  g.allowPreRelax = false;
  assert.match(g.rdFail.title, /^12월 31일\(목\) 근무 인원이 1명 모자라/);
  g.allowPreRelax = true; g.allowJuhuRelax = false;
  assert.equal(g.rdFail.title, '사전입력 완화를 켜도 만들 수 없어요 — 완화로 바꿀 수 없는 칸끼리 규칙이 맞지 않습니다.');
  assert.match(g.rdFail.body, /잠근 칸\(🔒\)과 주휴·지난달 칸을 바꾸지 않습니다/);
  assert.deepEqual(g.rdFail.fixes, []);                            // 엄격 기준 신호등이 짚은 칸은 내지 않는다
  g._staffingSlack = () => ({ short: [{ dk: '2026-12-19', needed: 9, avail: 7 }], tight: [] });   // 잠근 칸만으로도 모자란 날
  assert.match(g.rdFail.title, /^12월 19일\(토\) 근무 인원이 2명 모자라/);
  assert.match(g.rdFail.body, /^완화를 켜도 그날 잠근 칸·주휴를 빼면 나올 수 있는 사람은 7명/);
}

console.log('solve-stats: 모든 검증 통과');
