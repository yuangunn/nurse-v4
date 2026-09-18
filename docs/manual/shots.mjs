// 설명서용 실제 화면 캡처 — 예시 데이터(홍길동 등) (2026-09-18)
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
const HTML='file://'+path.resolve(HERE,'../../standalone/assign.html');
const OUT=path.join(HERE,'shots')+path.sep;
mkdirSync(OUT,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM||'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox']});
const page=await (await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:2})).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e)));
page.on('dialog',d=>d.accept());
const shot=async(name,clip)=>{ await page.waitForTimeout(250); await page.screenshot({path:OUT+name+'.png',...(clip?{clip}:{})}); console.log('  '+name); };
const el=async(name,sel)=>{ const h=await page.$(sel); if(!h){ console.log('  !! 없음 '+sel); return; } await page.waitForTimeout(200); await h.screenshot({path:OUT+name+'.png'}); console.log('  '+name); };

await page.goto(HTML); await page.waitForTimeout(800);

// ── 1. 시작 화면 (연결 전) ──
await page.evaluate(()=>{ try{hideIntro();}catch(e){} });
await shot('01-start',{x:0,y:0,width:1920,height:900});

// ── 예시 데이터 채우기 ──
const NAMES=['홍길동','김영숙','이순신','박미경','최정훈','정다래','강민호','윤서영','임태균','오현주','서준호','한지민'];
await page.evaluate(names=>{
  window.__memoryMode=true; store=emptyStore(); afterLoad();
  setWard('101');
  store.order=names.slice();
  names.forEach(n=>store.caps[n]=['DC','D','EC','E','NC','N']);
  for(const k of ['sun','mon','tue','wed','thu','fri','sat']) store.req[k]={D:5,E:4,N:3};
  const t=new Date(2026,8,13);   // 2026-09-13 (일)
  const iso=k=>isoOfD(addDays(t,k));
  // 3주치 근무표 — D5 E4 N3
  const plan=['D','D','D','D','D','E','E','E','E','N','N','N'];
  for(let k=-7;k<21;k++){ const d=iso(k); names.forEach((n,i)=>{ (store.cells[n]=store.cells[n]||{})[d]=plan[(i+k+14)%12]; }); }
  store.cells['홍길동'][iso(2)]='중';
  store.events[iso(1)]='신규 간호사 교육 14:00';
  wkSunday=new Date(2026,8,13);
  touch(); recompute(); show('week');
},NAMES);
await page.waitForTimeout(600);

// ── 2. 병실 목록 ──
await page.evaluate(()=>{ show('admin'); pickAdmin('rooms'); });
await shot('02-rooms',{x:230,y:60,width:1500,height:620});

// ── 3. 간호사 관리 ──
await page.evaluate(()=>{ pickAdmin('caps'); });
await shot('03-nurses',{x:230,y:60,width:1500,height:700});

// ── 4. 근무표 넣기 (붙여넣기 화면 빈 상태) ──
await page.evaluate(()=>{ show('paste'); });
await shot('04-paste-empty',{x:230,y:60,width:1500,height:560});

// ── 5. 붙여넣기 미리보기 ──
await page.evaluate(names=>{
  const y=2026,m=10,dim=31;
  const hdr=['이름',...Array.from({length:dim},(_,i)=>`${m}/${i+1}`)];
  const plan=['D','D','D','D','D','E','E','E','E','N','N','N'];
  const rows=names.map((n,r)=>[n,...Array.from({length:dim},(_,i)=>plan[(i+r)%12])]);
  ingestGrid([hdr,...rows]);
},NAMES);
await page.waitForTimeout(500);
await shot('05-paste-preview',{x:230,y:60,width:1500,height:700});

// ── 6. 배정표 화면 (주간) ──
await page.evaluate(()=>{ resetPaste(); show('week'); wkSunday=new Date(2026,8,13); renderWeek(); });
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

// ── 10. 인쇄 미리보기 ──
await page.evaluate(async ()=>{ closeRoomPick(); await buildPrintArea(false);
  const pa=document.querySelector('#printArea'); pa.style.display='block'; pa.style.position='relative';
  document.querySelector('.app').style.display='none'; window.scrollTo(0,0); });
await page.waitForTimeout(500);
await el('10-print','#printArea .sheet');

// ── 11. 툴바 (버튼 줄) ──
await page.evaluate(()=>{ const pa=document.querySelector('#printArea'); pa.style.display='none';
  document.querySelector('.app').style.display=''; show('week'); window.scrollTo(0,0); });
await page.waitForTimeout(400);
await el('11-toolbar','#scrWeek .wknav');

await el('11b-topbar','.topbar');
// ── 12. 데이터 보관(백업) ──
await page.evaluate(()=>{ show('admin'); pickAdmin('data'); });
await shot('12-backup',{x:230,y:60,width:1500,height:560});

// ── 13. 방 구성 ──
await page.evaluate(()=>{ pickAdmin('schemes'); });
await shot('13-schemes',{x:230,y:60,width:1500,height:760});

// ── 14. 도움말 ──
await page.evaluate(()=>{ show('week'); openHelp(); });
await page.waitForTimeout(500);
await shot('14-help',{x:230,y:60,width:1500,height:760});

// ── 15. 확인 필요 카드 ──
await page.evaluate(()=>{ closeHelp(); show('week');
  store.cells['김영숙']['2026-09-15']='OF'; store.cells['박미경']['2026-09-15']='OF';
  touch(); recompute(); renderWeek(); });
await page.waitForTimeout(400);
await el('15-warn','#wkWarn');

console.log('오류:',errs.length?errs:'없음');
await browser.close();
