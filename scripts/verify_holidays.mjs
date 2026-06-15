#!/usr/bin/env node
/* 한국 공휴일 자동계산 검증 — 실제 프론트 코드(misc-features.js)를 그대로 로드해
 * _computeKRHolidays(year) 출력이 KASI(한국천문연구원) 기준 골든셋과 일치하는지 확인.
 * 골든셋은 korean_lunar_calendar 라이브러리로 생성한 권위 데이터(tests/fixtures).
 * 사용: node scripts/verify_holidays.mjs   (실패 시 비정상 종료코드)
 */
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcPath = path.join(root, 'frontend/js/modules/misc-features.js');
const goldenPath = path.join(root, 'tests/fixtures/kr_holidays_golden.json');

const code = fs.readFileSync(srcPath, 'utf8');
const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

// 브라우저 전역(window)만 제공해 실제 모듈을 평가
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'misc-features.js' });
const mod = sandbox.window.MiscFeaturesModule();

let fail = 0;
const years = Object.keys(golden).map(Number).sort((a, b) => a - b);
for (const y of years) {
  const got = mod._computeKRHolidays.call(mod, y);
  const exp = golden[String(y)];
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g !== e) {
    fail++;
    const G = new Set(got), E = new Set(exp);
    console.error(`❌ ${y} 불일치`);
    console.error(`   계산엔 있음(+): ${exp ? got.filter(d => !E.has(d)) : got}`);
    console.error(`   계산엔 없음(-): ${exp ? exp.filter(d => !G.has(d)) : '(golden 없음)'}`);
  }
}

// 범위 밖 연도는 null 반환해야 함 (UI가 안내 토스트로 폴백)
const [lo, hi] = mod._lunarRange.call(mod);
if (mod._computeKRHolidays.call(mod, lo - 1) !== null || mod._computeKRHolidays.call(mod, hi + 1) !== null) {
  fail++; console.error(`❌ 범위 밖 연도가 null을 반환하지 않음`);
}

if (fail) {
  console.error(`\n검증 실패: ${fail}건`);
  process.exit(1);
}
console.log(`✅ 공휴일 자동계산 검증 통과 — ${years.length}개 연도(${years[0]}~${years.at(-1)}) 전부 KASI 골든셋과 일치, 범위밖 폴백 정상`);
