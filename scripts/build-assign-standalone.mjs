// assign-core.js + 병실 배정표.xlsx·병실 배정표_122.xlsx(base64, 배정표 서식 두 벌) + 폰트를 standalone/assign.html 마커에 재주입 (단일 소스 동기화)
// 도움말 그림(GIF)은 2026-09-17 에 실제 화면 투어로 대체돼 더 이상 심지 않는다.
// 사용: node scripts/build-assign-standalone.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const core = readFileSync('frontend/js/modules/assign-core.js', 'utf8')
  .replace(/^\/\*[\s\S]*?\*\/\s*/, ''); // 상단 주석 블록 제거
const tplB64 = readFileSync('standalone/병실 배정표.xlsx').toString('base64');
const tpl122B64 = readFileSync('standalone/병실 배정표_122.xlsx').toString('base64');   // 122병동 서식 (2026-09-17)
const tpl102B64 = readFileSync('standalone/병실 배정표_102.xlsx').toString('base64');   // 102병동 서식 (2026-09-20) — 방 칸 없이 자리·이름만
const fontB64 = readFileSync('frontend/fonts/PretendardVariable.woff2').toString('base64');

const htmlPath = 'standalone/assign.html';
const html = readFileSync(htmlPath, 'utf8');

/* 버전 = v + 만든 날짜(YYMMDD) + 그날 몇 번째인지(a, b, c …).
 * 병동 PC마다 파일이 섞이므로 번호만 보고 최신본을 가릴 수 있어야 한다.
 * 직전 버전을 지금 파일에서 읽어, 같은 날이면 알파벳만 올린다. */
const _d = new Date();      // 표준시가 아니라 만든 사람 기준 날짜로
const stamp = `${String(_d.getFullYear()).slice(2)}`
  + `${String(_d.getMonth() + 1).padStart(2, '0')}${String(_d.getDate()).padStart(2, '0')}`;
const nextSuffix = (s) => {           // a→b … z→aa→ab (엑셀 열 이름과 같은 방식)
  const a = s.split('');
  for (let i = a.length - 1; ; i--) {
    if (a[i] !== 'z') { a[i] = String.fromCharCode(a[i].charCodeAt(0) + 1); break; }
    a[i] = 'a';
    if (i === 0) { a.unshift('a'); break; }
  }
  return a.join('');
};
const prev = html.match(/const BUILD=\{ver:'v(\d{6})([a-z]+)'/);
const ASSIGN_VER = `v${stamp}` + (prev && prev[1] === stamp ? nextSuffix(prev[2]) : 'a');
let out = html.replace(
  /\/\*ASSIGN_CORE_BEGIN\*\/[\s\S]*?\/\*ASSIGN_CORE_END\*\//,
  '/*ASSIGN_CORE_BEGIN*/\n' + core.trim() + '\n/*ASSIGN_CORE_END*/'
);
out = out.replace(
  /\/\*TEMPLATE_B64_BEGIN\*\/[\s\S]*?\/\*TEMPLATE_B64_END\*\//,
  '/*TEMPLATE_B64_BEGIN*/' + tplB64 + '/*TEMPLATE_B64_END*/'
);
out = out.replace(
  /\/\*TEMPLATE122_B64_BEGIN\*\/[\s\S]*?\/\*TEMPLATE122_B64_END\*\//,
  '/*TEMPLATE122_B64_BEGIN*/' + tpl122B64 + '/*TEMPLATE122_B64_END*/'
);
out = out.replace(
  /\/\*TEMPLATE102_B64_BEGIN\*\/[\s\S]*?\/\*TEMPLATE102_B64_END\*\//,
  '/*TEMPLATE102_B64_BEGIN*/' + tpl102B64 + '/*TEMPLATE102_B64_END*/'
);
// Pretendard Variable 내장 (오프라인 단일 파일 — CDN 금지)
out = out.replace(
  /\/\*FONT_B64_BEGIN\*\/[\s\S]*?\/\*FONT_B64_END\*\//,
  "/*FONT_B64_BEGIN*/@font-face{font-family:'Pretendard Variable';" +
  'src:url(data:font/woff2;base64,' + fontB64 + ") format('woff2-variations');" +
  'font-weight:45 920;font-display:swap}/*FONT_B64_END*/'
);
out = out.replace(
  /\/\*BUILD_INFO_BEGIN\*\/[\s\S]*?\/\*BUILD_INFO_END\*\//,
  `/*BUILD_INFO_BEGIN*/const BUILD={ver:'${ASSIGN_VER}'};/*BUILD_INFO_END*/`
);
if (out === html) console.log('변경 없음');
else { writeFileSync(htmlPath, out); console.log(`standalone/assign.html 동기화 완료 — ${ASSIGN_VER}`,
    '· 코어 + 양식 3벌(101·122·102) + 폰트 (도움말은 그림 없이 실제 화면 투어)'); }
