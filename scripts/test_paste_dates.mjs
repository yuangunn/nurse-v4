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
