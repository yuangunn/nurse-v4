// assign-core.js를 standalone/assign.html의 마커 사이에 재주입 (단일 소스 동기화)
// 사용: node scripts/build-assign-standalone.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const core = readFileSync('frontend/js/modules/assign-core.js', 'utf8')
  .replace(/^\/\*[\s\S]*?\*\/\s*/, ''); // 상단 주석 블록 제거
const htmlPath = 'standalone/assign.html';
const html = readFileSync(htmlPath, 'utf8');
const out = html.replace(
  /\/\*ASSIGN_CORE_BEGIN\*\/[\s\S]*?\/\*ASSIGN_CORE_END\*\//,
  '/*ASSIGN_CORE_BEGIN*/\n' + core.trim() + '\n/*ASSIGN_CORE_END*/'
);
if (out === html) console.log('변경 없음');
else { writeFileSync(htmlPath, out); console.log('standalone/assign.html 코어 동기화 완료'); }
