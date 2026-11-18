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
assert.equal(f.rdSolveCards.find(c => c.k === 'BestSol').v, '—');
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
  '1|0|Presolve — 22,766 → 15,097 rows · 7,414 → 6,834 cols',
  '1|32.3|첫 해 발견 — Src L (Sub-MIP)',
  '1|32.3|Restart — inactive integer columns 24.2% → 12,271 rows · 4,885 cols',
  '1|97.1|더 좋은 해 발견 — Src T (Evaluate node)',
  '1|97.1|Solving report — Optimal',
  '2|0|MIP start — 앞에서 찾은 해로 시작 (objective 5465)',
  '2|0|Presolve — 22,782 → 15,242 rows · 7,431 → 6,884 cols',
  '2|78.3|더 좋은 해 발견 — Src L (Sub-MIP)',
]);
assert.equal(f.rdSolveEvents[0].text, '더 좋은 해 발견 — Src L (Sub-MIP)');          // 새 것이 위
assert.deepEqual(f.rdSolveCards.map(c => `${c.k}=${c.v}`), ['노드 (Proc.)=101', '대기 (InQueue)=10', '리프 (Leaves)=31', '탐색 (Expl.)=0.05%',
  'BestSol=-3155', 'BestBound=-4578.52102', 'Gap=45.12%', 'Cuts=3,615', 'Confl.=479', 'LP iters=216,551', '방법 (Src)=L · Sub-MIP']);
assert.equal(f.rdSolveSub, 'Solve #2 · Presolve 22,782 → 15,242 rows · 7,431 → 6,884 cols');
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
assert.equal(S.events.at(-1).text, '더 좋은 해 발견 — Src z (Trivial zero)');

// HiGHS 기록이 아니면(CP-SAT) 진행 정보의 노드·Gap 만
f._solveReset(); f._pushLog('#1       0.52s best:1200  next:[900,1100]  no_lp');
assert.deepEqual(f.rdSolveCards, []);
f.solveProgress = { nodes: 1520, gap_percent: 3.456 };
assert.deepEqual(f.rdSolveCards.map(c => `${c.k}=${c.v}`), ['노드=1,520', 'Gap=3.46%']);

// 결과 요약 단계 — 계산 → 지킨 것 → (바꾼 것) → (확인할 것) → 결과. 없는 장은 건너뛴다
f._solveReset();
for (const l of ['Presolving model', '100 rows, 50 cols, 300 nonzeros  0s', '80 rows, 40 cols, 200 nonzeros  0s', 'Solving MIP model with:', row('H', 12, 0, 5, '100.00%', -10, -10, '0.00%', 3, 2, 1, 900, 75.4), '  Status            Optimal']) f._solveFeed(l);
for (const [k, v] of [['rdSched', true], ['rdRelaxedCount', 0], ['rdTraineeChanged', 0]]) Object.defineProperty(f, k, { value: v, writable: true });   // 계산 속성을 값으로
Object.assign(f, { mipGapPercent: 0, scheduleStopped: false, generationReport: { duration_seconds: 75.4 }, rdSaved: true,
  countPrevEntries: () => 40, scheduleDays: [new Date(2026, 11, 1), new Date(2026, 11, 2)], isOverflow: () => false,
  footerRows: [{ label: 'D', shifts: ['DC', 'D'] }, { label: 'E', shifts: ['EC', 'E'] }, { label: 'N', shifts: ['NC', 'N'] }, { label: '휴무', shifts: ['OF'] }],
  got: { D: 5, E: 5, N: 3 }, getDayDutyCount(d, shifts) { return this.got[shifts[1]] ?? 0; }, rdFootNeed: (d, c) => ({ D: 5, E: 5, N: 3 })[c],
  scheduleWarnings: [], offTeukgeun: [], vReport: null, wishReport: null });
assert.deepEqual(f.rdStorySteps.map(s => s.id), ['calc', 'kept', 'done']);
assert.equal(f.rdStorySteps[0].title, '노드 12개를 따져 봤어요');
assert.deepEqual(f.rdStorySteps[0].facts, [['걸린 시간', '1분 15초'], ['풀이 횟수 (Solve)', '1회'], ['처리한 노드 (Proc.)', '12'], ['닫힌 리프 (Leaves)', '5'],
  ['LP iterations', '900'], ['Presolve', '100 → 80 rows'], ['해를 찾은 방법 (Src)', 'H · Heuristic'], ['Status', 'Optimal'], ['Gap', '0%']]);
assert.equal(f.rdStorySteps[1].title, '사전입력 40칸을 모두 지켰어요');
assert.deepEqual(f.rdStorySteps[1].facts.at(-1), ['날마다 필요 인원 (D·E·N)', '모두 채움']);
f.got.E = 4; assert.equal(f.rdStorySteps[1].facts.at(-1)[1], '2곳 모자람'); f.got.E = 5;   // 이틀 × E
f.rdRelaxedCount = 3; f.scheduleWarnings = [{ type: 'check' }, { type: 'info' }]; f.offTeukgeun = [{}]; f.vReport = { total: 2 };
assert.deepEqual(f.rdStorySteps.map(s => s.id), ['calc', 'kept', 'changed', 'check', 'done']);
assert.equal(f.rdStorySteps[1].title, '사전입력 40칸 중 37칸을 지켰어요');
assert.deepEqual(f.rdStorySteps[3].facts.map(x => x.slice(1)), [['1건', 'warn'], ['1건', 'teukgeun'], ['2건', 'v']]);
// 넘기기 — 마지막 장에서 다음을 누르면 닫힌다
f.rdStoryOpen(); assert.deepEqual(f.story, { open: true, step: 0 });
f.rdStoryGo(-1); assert.equal(f.story.step, 0);
for (let i = 0; i < 4; i++) f.rdStoryGo(1);
assert.deepEqual([f.story.open, f.story.step, f.rdStoryStep.id], [true, 4, 'done']);
f.rdStoryGo(1); assert.equal(f.story.open, false);
f.rdSched = false; assert.deepEqual(f.rdStorySteps, []);

console.log('solve-stats: 모든 검증 통과');
