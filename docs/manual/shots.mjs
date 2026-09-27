// 설명서용 실제 화면 캡처 — 예시 데이터(홍길동 등) (2026-09-18, 2026-09-27 다시 찍음)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const HTML='file://'+path.resolve(HERE,'../../standalone/assign.html');
const OUT=path.join(HERE,'shots')+path.sep;
mkdirSync(OUT,{recursive:true});
// 한국어 — 날짜 칸이 병동 PC 처럼 '2026. 09. 16.' 로 나오게 (날짜 칸 모양은 locale 이 아니라 LANG 을 따른다)
const browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox','--lang=ko-KR'],
  env:{...process.env,LANG:'ko_KR.UTF-8',LANGUAGE:'ko',LC_ALL:'ko_KR.UTF-8'}});
const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:2,locale:'ko-KR'})).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
page.on('dialog',d=>d.accept());
const shot=async(name,clip)=>{ await page.waitForTimeout(250); await page.screenshot({path:OUT+name+'.png',...(clip?{clip}:{})}); console.log('  '+name); };
const el=async(name,sel)=>{ const h=await page.$(sel); if(!h){ console.log('  !! 없음 '+sel); return; } await page.waitForTimeout(200); await h.screenshot({path:OUT+name+'.png'}); console.log('  '+name); };
// 관리 화면 = 왼쪽 메뉴 + 패널 (1920 에서 x 220~1700)
const ADMIN=h=>({x:220,y:60,width:1480,height:h});

await page.goto(HTML);

// ── 1. 처음 켰을 때 — 설정 안내의 첫 단계(환영)가 바로 뜬다 ──
await page.waitForSelector('#wiz.on',{timeout:8000});
await el('01-start','#wizBox');
await page.evaluate(()=>closeWizard());

// ── 예시 데이터 채우기 — 14명, 매일 D5 · E4 · N3 · 쉬는 사람 2 ──
const NAMES=['홍길동','김영숙','이순신','박미경','최정훈','정다래','강민호','윤서영','임태균','오현주','서준호','한지민','장영실','허준'];
const PLAN=['D','D','D','D','D','E','E','E','E','N','N','N','OF','OF'];
await page.evaluate(({names,plan})=>{
  window.__memoryMode=true; store=emptyStore(); afterLoad();
  setWard('101'); store.wardPicked=true;
  store.order=names.slice();
  names.forEach(n=>store.caps[n]=['DC','D','EC','E','NC','N']);
  const t=new Date(2026,8,13);   // 2026-09-13 (일)
  const iso=k=>isoOfD(addDays(t,k));
  for(let k=-7;k<21;k++){ const d=iso(k); names.forEach((n,i)=>{ (store.cells[n]=store.cells[n]||{})[d]=plan[(i+k+14)%plan.length]; }); }
  store.cells['홍길동'][iso(2)]='중';
  // 교육·행사 — 이 날만 하나, 매주 목요일 하나
  store.evRules=[{id:'e1',text:'신규 간호사 교육 14:00',from:iso(1),to:iso(1)},
                 {id:'e2',text:'물품 점검',from:iso(-7),to:'',wds:[4]}];
  wkSunday=new Date(2026,8,13);
  touch(); recompute(); show('week');
},{names:NAMES,plan:PLAN});
await page.waitForTimeout(600);

// ── 2. 병실 목록 (병동 ⇄ 서식 카드) ──
await page.evaluate(()=>{ show('admin'); pickAdmin('rooms'); window.scrollTo(0,0); });
await shot('02-rooms',ADMIN(700));

// ── 3. 간호사 관리 ──
await page.evaluate(()=>{ pickAdmin('caps'); window.scrollTo(0,0); });
await shot('03-nurses',ADMIN(700));

// ── 4. 근무표 넣기 (붙여넣기 화면 빈 상태) ──
await page.evaluate(()=>{ show('paste'); window.scrollTo(0,0); });
await el('04-paste-empty','#scrPaste');

// ── 5. 붙여넣기 미리보기 — 날짜 줄에 일자만 있고, 모르는 표기(조가)가 섞인 표 ──
await page.evaluate(({names,plan})=>{
  const dim=31;
  const hdr=['이름',...Array.from({length:dim},(_,i)=>String(i+1))];
  const rows=names.map((n,r)=>[n,...Array.from({length:dim},(_,i)=>plan[(i+r)%plan.length])]);
  rows[2][6]='조가'; rows[8][20]='조가';
  ingestGrid([hdr,...rows]);
},{names:NAMES,plan:PLAN});
await page.waitForTimeout(500);
{ const b=await page.evaluate(()=>{ const r=document.querySelector('#pvCard').getBoundingClientRect(); return {x:r.x,y:r.y+scrollY,w:r.width}; });
  await shot('05-paste-preview',{x:b.x,y:b.y,width:b.w,height:640}); }

// ── 6. 배정표 화면 (주간) ──
await page.evaluate(()=>{ resetPaste(); show('week'); wkSunday=new Date(2026,8,13); renderWeek(); window.scrollTo(0,0); });
await page.waitForTimeout(400);
await el('06-week','#wkTable');

// ── 7. 담당 바꾸기 (이름 클릭) ──
await page.evaluate(()=>{
  const td=[...document.querySelectorAll('#wkTable td.nm[data-n]')].find(x=>x.dataset.iso==='2026-09-14');
  openPick(td.dataset.n,td.dataset.iso,700,320);
});
await el('07-pick','#pick');

// ── 8. 방 바꾸기 (방 칸 클릭) ──
await page.evaluate(()=>{ closePick();
  const td=[...document.querySelectorAll('#wkTable td.rm[data-iso]')].find(x=>x.dataset.iso==='2026-09-14'&&x.dataset.p==='D');
  openRoomPick({kind:'day',iso:td.dataset.iso,P:td.dataset.p,l:td.dataset.l},700,320);
});
await el('08-rooms-pick','#rpick');

// ── 9. 병상 나누기 (⋮ 펼침) ──
await page.evaluate(()=>{ toggleBedOpen('1001'); });
await el('09-beds','#rpick');

// ── 16. 빈 자리 누르기 — 쉬는 간호사 · 대체간호사 넣기 ──
await page.evaluate(()=>{ closeRoomPick();
  const td=[...document.querySelectorAll('#wkTable td.emp[data-empty]:not(.rm)')].find(x=>x.dataset.iso==='2026-09-14');
  openEmptyPick(td.dataset.iso,td.dataset.p,td.dataset.l,700,320);
});
await el('16-empty','#pick');

// ── 17. 교육·행사 일정 넣기 — 매주 요일 ──
await page.evaluate(()=>{ closePick(); editEventRule('2026-09-16',null); });
await page.waitForTimeout(300);
await page.evaluate(()=>{
  const b=document.querySelector('#modalBox');
  b.querySelector('#evText').value='CPR 교육 15:00';
  b.querySelector('#evmW').checked=true;
  b.querySelectorAll('.wdPick input').forEach(c=>{ c.checked=['3','5'].includes(c.value); });   // 수 · 금
  b.querySelector('#mdForm').dispatchEvent(new Event('change',{bubbles:true}));
  document.activeElement&&document.activeElement.blur();
});
await el('17-event','#modalBox');
await page.evaluate(()=>closeModal(null));

// ── 10. 인쇄 미리보기 ──
await page.evaluate(async ()=>{ await buildPrintArea(false);
  const pa=document.querySelector('#printArea'); pa.style.display='block'; pa.style.position='relative';
  document.querySelector('.app').style.display='none'; window.scrollTo(0,0); });
await page.waitForTimeout(500);
await el('10-print','#printArea .sheet');

// ── 11. 툴바 (버튼 줄) ──
await page.evaluate(()=>{ const pa=document.querySelector('#printArea'); pa.style.display='none';
  document.querySelector('.app').style.display=''; show('week'); window.scrollTo(0,0); });
await page.waitForTimeout(400);
await el('11-toolbar','#scrWeek .wknav');

// ── 12. 데이터 보관(백업) ──
await page.evaluate(()=>{ show('admin'); pickAdmin('data'); window.scrollTo(0,0); });
await shot('12-backup',ADMIN(420));

// ── 13. 방 구성 ──
await page.evaluate(()=>{ pickAdmin('schemes'); window.scrollTo(0,0); });
await shot('13-schemes',ADMIN(740));

// ── 14. 도움말 ──
await page.evaluate(()=>{ show('week'); openHelp(); });
await page.waitForTimeout(500);
await shot('14-help',{x:220,y:60,width:1480,height:760});

// ── 15. 확인 필요 카드 — 차지 자격 없음 · 아무도 안 보는 방 · 자리보다 많은 사람(안내) ──
await page.evaluate(()=>{ closeHelp(); show('week');
  store.order.forEach(n=>{ if(n!=='홍길동'&&n!=='김영숙') store.caps[n]=['DC','D','EC','E','N']; });   // NC 는 두 사람만
  store.schemes[4].C=store.schemes[4].C.filter(r=>r!=='1010');                                      // 4인 방 구성에서 10호가 빠짐
  store.cells['임태균']['2026-09-17']='D';                                                             // 쉬는 날에 D — 17일 D 여섯 명
  touch(); recompute(); renderWeek(); });
await page.waitForTimeout(400);
await el('15-warn','#wkWarn');

console.log('오류:',errs.length?errs:'없음');
await browser.close();
