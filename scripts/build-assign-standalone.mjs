// assign-core.js + 병실 배정표.xlsx(base64)를 standalone/assign.html 마커에 재주입 (단일 소스 동기화)
// 사용: node scripts/build-assign-standalone.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const core = readFileSync('frontend/js/modules/assign-core.js', 'utf8')
  .replace(/^\/\*[\s\S]*?\*\/\s*/, ''); // 상단 주석 블록 제거
const tplB64 = readFileSync('standalone/병실 배정표.xlsx').toString('base64');
const fontB64 = readFileSync('frontend/fonts/PretendardVariable.woff2').toString('base64');

const htmlPath = 'standalone/assign.html';
const html = readFileSync(htmlPath, 'utf8');
let out = html.replace(
  /\/\*ASSIGN_CORE_BEGIN\*\/[\s\S]*?\/\*ASSIGN_CORE_END\*\//,
  '/*ASSIGN_CORE_BEGIN*/\n' + core.trim() + '\n/*ASSIGN_CORE_END*/'
);
out = out.replace(
  /\/\*TEMPLATE_B64_BEGIN\*\/[\s\S]*?\/\*TEMPLATE_B64_END\*\//,
  '/*TEMPLATE_B64_BEGIN*/' + tplB64 + '/*TEMPLATE_B64_END*/'
);
// Pretendard Variable 내장 (오프라인 단일 파일 — CDN 금지)
out = out.replace(
  /\/\*FONT_B64_BEGIN\*\/[\s\S]*?\/\*FONT_B64_END\*\//,
  "/*FONT_B64_BEGIN*/@font-face{font-family:'Pretendard Variable';" +
  'src:url(data:font/woff2;base64,' + fontB64 + ") format('woff2-variations');" +
  'font-weight:45 920;font-display:swap}/*FONT_B64_END*/'
);
if (out === html) console.log('변경 없음');
else { writeFileSync(htmlPath, out); console.log('standalone/assign.html 동기화 완료 (코어 + 양식 + 폰트 base64)'); }
