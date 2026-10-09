// 설명서용 실제 화면 캡처 — 예시 데이터(홍길동 등) (2026-09-18, 2026-09-27·09-28·10-09 다시 찍음)
// 25-example 만 앱의 예시(makeExample('101') — 옛이야기 이름)로 찍는다
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
// 관리 화면 = 왼쪽 메뉴 + 패널 (1920 에서 x 220~1700) — 머리줄 60px 아래 4px 부터
const ADMIN=h=>({x:220,y:64,width:1480,height:h});

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
  // 그룹 — 갓 독립한 신규 둘. 서로 인계하지 않게(인계 피하기 켬)
  store.groups=[{id:'g1',name:'신규 독립',members:['장영실','허준'],noHandover:true}];
  // 교육·행사 — 이 날만 하나, 매주 목요일 하나
  store.evRules=[{id:'e1',text:'신규 간호사 교육 14:00',from:iso(1),to:iso(1)},
                 {id:'e2',text:'물품 점검',from:iso(-7),to:'',wds:[4]}];
  wkSunday=new Date(2026,8,13);
  // 머리줄 저장 상태 — 파일에 저장된 것처럼 (캡처는 파일을 쓰지 않는다)
  window.writeStore=async()=>{ dirty=false; saveMsg(''); };
  const sv=new Date(); sv.setHours(14,2,0,0); store.saved=sv.toISOString();
  setFileLoc({kind:'file',name:'assign-data.js'});
  touch(); recompute(); show('week');
},{names:NAMES,plan:PLAN});
await page.waitForTimeout(1200);

// ── 2. 병실 목록 (병동 ⇄ 서식 카드) ──
await page.evaluate(()=>{ show('admin'); pickAdmin('rooms'); window.scrollTo(0,0); });
await shot('02-rooms',ADMIN(700));

// ── 3. 간호사 관리 ──
await page.evaluate(()=>{ pickAdmin('caps'); window.scrollTo(0,0); });
await shot('03-nurses',ADMIN(700));

// ── 21. 그룹 — 간호사 관리 위쪽(그룹 만들기 · 그룹 띠 · 표 머리) + 그룹원 두 줄(그룹 칸이 켜진 장영실·허준) ──
// 창을 길게 늘려 표 전체가 스크롤 없이 보이게 한 뒤 두 곳을 잘라 낸다 (설명서는 두 그림 사이를 줄였다고 적는다)
await page.setViewportSize({width:1920,height:2000});
await page.evaluate(()=>window.scrollTo(0,0));
{ const b=await page.evaluate(()=>{ const p=document.querySelector('#adminPanelBox').getBoundingClientRect();
    const hd=document.querySelector('#capsTable tr.hd').getBoundingClientRect();
    const rows=[...document.querySelectorAll('#capsTable tr.nrow')].filter(tr=>/장영실|허준/.test(tr.querySelector('td.nm2').textContent));
    const a=rows[0].getBoundingClientRect(), z=rows[rows.length-1].getBoundingClientRect();
    return {top:{x:p.x,y:p.y,width:p.width,height:hd.bottom-p.y+2},
            rows:{x:p.x,y:a.top-2,width:p.width,height:z.bottom-a.top+6}}; });
  await shot('21-groups',b.top);
  await shot('21-members',b.rows); }
await page.setViewportSize({width:1920,height:1080});

// ── 22. 배정 원칙 — 원칙 4 아래 '그룹원끼리 인계 피하기' ──
// 1920 에서는 줄이 1200px 로 늘어나 A4 에서 글자가 너무 작다 — 이 그림만 창 폭 1280 으로 찍는다
await page.setViewportSize({width:1280,height:1080});
await page.evaluate(()=>{ pickAdmin('rules'); window.scrollTo(0,0); });
{ const b=await page.evaluate(()=>{ const p=document.querySelector('#adminPanelBox').getBoundingClientRect();
    const r4=document.querySelectorAll('#adminPanelBox .rulRow')[3].getBoundingClientRect();
    return {x:p.x,y:r4.top-14,width:p.width,height:p.bottom-r4.top+14}; });
  await shot('22-rules',b); }
await page.setViewportSize({width:1920,height:1080});

// ── 24. 그룹의 가능 근무·주지 않을 방 — 신규 독립의 DC·EC·NC 를 끄고 3호를 주지 않는다 (찍고 나서 되돌린다) ──
{ const keep=await page.evaluate(()=>{ const k=JSON.stringify(store.groups);
    grpRestrict(store.groups[0],['D','E','N'],['1003']); touch(); recompute(); show('admin'); pickAdmin('caps'); return k; });
  await page.setViewportSize({width:1920,height:2000});
  await page.evaluate(()=>window.scrollTo(0,0));
  const b=await page.evaluate(()=>{ const t=document.querySelector('#adminPanelBox .grpTable').getBoundingClientRect();
    const rows=[...document.querySelectorAll('#capsTable tr.nrow')].filter(tr=>/장영실|허준/.test(tr.querySelector('td.nm2').textContent));
    const a=rows[0].getBoundingClientRect(), z=rows[rows.length-1].getBoundingClientRect();
    return {top:{x:t.x-4,y:t.y-4,width:t.width+8,height:t.height+8},
            rows:{x:t.x-4,y:a.top-2,width:t.width+8,height:z.bottom-a.top+6}}; });
  await shot('24-group-limits',b.top);
  await shot('24-group-rows',b.rows);
  await page.setViewportSize({width:1920,height:1080});
  await page.evaluate(k=>{ store.groups=JSON.parse(k); touch(); recompute(); },keep); }

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
await el('20-header','.topbar');   // 맨 위 줄 — 병동 · 가운데 탭 · 저장 상태 · 도움말 (2026-09-28 머리줄 바꿈)

// ── 당직표·번호 — 정형외과식 당직표(연차만 적힘) + 번호표. 번호표에 없는 이름 하나(번호 없음) ──
await page.evaluate(()=>{
  const R={}, res=['R1','R2','R3','R4'];
  for(let d=new Date(2026,7,30),i=0;d<=new Date(2026,9,3);d=addDays(d,1),i++) R[isoOfD(d)]=res[i%4];
  R['2026-09-30']='이황';
  store.duty={lines:{'GS 당직':{fixed:{phone:'010-0000-9999',ext:''}}},
    roster:{'OS 당직':R,'GS 당직':{'2026-09-14':'장영실'},'당직진료지원간호사':{'2026-09-14':'허난설'}},
    book:{'OS 당직':[
    {name:'R4 유성룡',phone:'010-0000-0004',ext:''},{name:'R3 정약용',phone:'010-0000-0003',ext:''},
    {name:'R2 김정호',phone:'010-0000-0002',ext:''},{name:'R1 안창호',phone:'010-0000-0001',ext:''},
    {name:'신사임당',phone:'010-0000-0010',ext:''}],
    '당직진료지원간호사':[{name:'허난설',phone:'010-0000-0100',ext:'48001'},{name:'황진이',phone:'010-0000-0101',ext:'48002'}]}};
});

// ── 18. 하루 어싸인표 (한글 양식) — 교육이 있는 월요일, 당직은 당직표에서 ──
await page.evaluate(()=>{ store.daily={}; openDay('2026-09-14'); window.scrollTo(0,0); });
await page.waitForTimeout(1500);
await shot('18-day',{x:0,y:60,width:1920,height:1020});

// ── 19. 관리 > 당직표·번호 ──
await page.evaluate(async ()=>{ dutyUI.y=2026; dutyUI.m=9; openDutyAdmin('OS 당직'); await renderDuty(); window.scrollTo(0,0); });
await page.waitForTimeout(400);
await shot('19-duty',{x:505,y:154,width:1195,height:910});   // 관리 패널만 (칸 탭·달력·번호표)

// ── 12. 데이터 보관(백업) ──
await page.evaluate(()=>{ show('admin'); pickAdmin('data'); window.scrollTo(0,0); });
await shot('12-backup',ADMIN(420));

// ── 13. 방 구성 ──
await page.evaluate(()=>{ pickAdmin('schemes'); window.scrollTo(0,0); });
await shot('13-schemes',ADMIN(740));

// ── 14. 도움말 ──
await page.evaluate(()=>{ show('week'); openHelp(); });
await page.waitForTimeout(500);
{ const b=await page.evaluate(()=>{ const r=document.querySelector('#helpPanel').getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:680}; });
  await shot('14-help',b); }   // 도움말 창만 (예전엔 화면에서 잘라 창 머리가 잘렸다)

// ── 15. 확인 필요 카드 — 차지 자격 없음 · 아무도 안 보는 방 · 자리보다 많은 사람(안내) · 같은 그룹 인계(안내) ──
await page.evaluate(()=>{ closeHelp(); show('week');
  store.order.forEach(n=>{ if(n!=='홍길동'&&n!=='김영숙') store.caps[n]=['DC','D','EC','E','N']; });   // NC 는 두 사람만
  store.schemes[4].C=store.schemes[4].C.filter(r=>r!=='1010');                                      // 4인 방 구성에서 10호가 빠짐
  store.cells['임태균']['2026-09-17']='D';                                                             // 쉬는 날에 D — 17일 D 여섯 명
  touch(); recompute(); renderWeek();
  // 19일 E — 허준을 손으로 장영실(D)이 보던 방의 자리로 옮긴다 → 같은 그룹 인계 안내
  const d='2026-09-19', D=result.byDay[d].D, E=result.byDay[d].E;
  const dl=Object.keys(D.labels).find(l=>D.labels[l]==='장영실'), nD=Object.keys(D.labels).length, nE=Object.keys(E.labels).length;
  const held=new Set(expandBeds(roomTokens(roomsFor('D',nD,dl,d))));
  const el=Object.keys(E.labels).find(l=>l!=='차지'&&expandBeds(roomTokens(roomsFor('E',nE,l,d))).some(t=>held.has(t)));
  openPick('허준',d,700,320); pickChoose(el); renderWeek(); });
await page.waitForTimeout(400);
await el('15-warn','#wkWarn');
// ── 23. 그 카드의 '같은 그룹 인계' 한 줄만 ──
{ const h=await page.evaluateHandle(()=>[...document.querySelectorAll('#wkWarn .warn')].find(x=>x.textContent.includes('같은 그룹')));
  if(h&&await h.evaluate(x=>!!x)){ await page.waitForTimeout(200); await h.asElement().screenshot({path:OUT+'23-handover.png'}); console.log('  23-handover'); }
  else console.log('  !! 같은 그룹 인계 줄이 없다'); }

// ── 25. 예시로 둘러보기 — 101병동 예시 (가상의 간호사·근무표, 저장 안 됨). 예시 카드는 1920 에서 표 오른쪽 열 ──
await page.evaluate(async ()=>{ closeHelp(); closePick(); await enterDemo(makeExample('101',{start:'2026-10-04'}));
  wkSunday=new Date(2026,9,4); renderWeek(); renderOnboard(); window.scrollTo(0,0);
  document.querySelector('#toast').style.display='none'; });   // 앞 그림(15)에서 남은 되돌리기 알림
await page.waitForTimeout(800);
await shot('25-example',{x:0,y:0,width:1920,height:760});

console.log('오류:',errs.length?errs:'없음');
await browser.close();
