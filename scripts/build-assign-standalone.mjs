// assign-core.js + 병실 배정표.xlsx(base64)를 standalone/assign.html 마커에 재주입 (단일 소스 동기화)
// 사용: node scripts/build-assign-standalone.mjs
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';

const core = readFileSync('frontend/js/modules/assign-core.js', 'utf8')
  .replace(/^\/\*[\s\S]*?\*\/\s*/, ''); // 상단 주석 블록 제거
const tplB64 = readFileSync('standalone/병실 배정표.xlsx').toString('base64');
const fontB64 = readFileSync('frontend/fonts/PretendardVariable.woff2').toString('base64');

// 도움말 그림 (standalone/help/*.gif|png) — 실제 화면을 찍은 것. 생성: scripts/make-help-media.py
// 버전 = 만든 날짜 (v2026.08.09). 병동 PC마다 파일이 섞이므로 번호만 보고 최신본을 가린다.
const _d = new Date();   // 표준시가 아니라 만든 사람 기준 날짜로
const ASSIGN_VER = `v${_d.getFullYear()}.${String(_d.getMonth() + 1).padStart(2, '0')}.${String(_d.getDate()).padStart(2, '0')}`;

const helpDir = 'standalone/help';
const media = {};
if (existsSync(helpDir)) {
  for (const f of readdirSync(helpDir).sort()) {
    const m = f.match(/^(.+)\.(gif|png)$/i);
    if (!m) continue;
    const mime = m[2].toLowerCase() === 'gif' ? 'image/gif' : 'image/png';
    media[m[1]] = `data:${mime};base64,` + readFileSync(`${helpDir}/${f}`).toString('base64');
  }
}

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
out = out.replace(
  /\/\*BUILD_INFO_BEGIN\*\/[\s\S]*?\/\*BUILD_INFO_END\*\//,
  `/*BUILD_INFO_BEGIN*/const BUILD={ver:'${ASSIGN_VER}'};/*BUILD_INFO_END*/`
);
out = out.replace(
  /\/\*HELP_MEDIA_BEGIN\*\/[\s\S]*?\/\*HELP_MEDIA_END\*\//,
  '/*HELP_MEDIA_BEGIN*/const HELP_MEDIA=' + JSON.stringify(media) + ';/*HELP_MEDIA_END*/'
);
if (out === html) console.log('변경 없음');
else { writeFileSync(htmlPath, out); console.log(`standalone/assign.html 동기화 완료 — ${ASSIGN_VER}`,
    `· 코어 + 양식 + 폰트 + 도움말 그림 ${Object.keys(media).length}개`); }
