/* ────────────────────────────────────────────────────────────────────────────
 * 리디자인 접착 모듈 (design/handoff) — 신호등 문장·단계 부제·상태 줄·실패 배너·서랍 탭·
 * 되돌리기 토스트·커스텀 툴팁·2단 확인·숫자 ±·셀 팝업 위치·인쇄 미리보기·폰 '내 근무'·
 * 서체 선택·검증용 상태 진입(window.__rdState)
 *
 * 원칙: 기존 핸들러(app.js·modules)는 그대로 두고 **문구와 배치만** 이 모듈이 계산한다.
 * 문구는 design/handoff/copy.json 을 그대로 쓴다 (의역 금지).
 * 사용: app() 반환 객체에 `...RedesignModule()` 로 스프레드.
 * ─────────────────────────────────────────────────────────────────────────── */
window.RedesignModule = function() {
  const WD = ['일','월','화','수','목','금','토'];
  const CODE_NAME = {DC:'Day Charge', D:'Day', D1:'상근·교육', EC:'Evening Charge', E:'Evening', '중':'중간번', NC:'Night Charge', N:'Night',
    OF:'오프', '주':'주휴', P1:'임부휴무', V:'연차', '생':'생리휴가', '특':'특별휴가', '공':'공적업무', '법':'법정공휴일', '병':'병가'};
  const WORK_ORDER = ['D','DC','D1','E','EC','중','N','NC'];
  const REST_ORDER = ['주','OF','V','생','특','공','법','병','P1'];
  const PERIOD_KO = {D:'낮', E:'저녁', N:'야간'};
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtMD = dk => `${+dk.slice(5,7)}/${+dk.slice(8,10)}`;
  const fmtKo = dk => { const d = new Date(dk + 'T00:00:00'); return `${d.getMonth()+1}월 ${d.getDate()}일(${WD[d.getDay()]})`; };
  return {
    // ── 상태 ──
    reportTab: 'summary',        // 서랍 탭: summary·relaxed·v·teukgeun·warn·wish·log
    rdToast: null,               // {msg, undo}
    _rdToastTimer: null,
    showPrintPreview: false,
    settingsSection: 'roster',   // roster·req·rules·shifts·scoring·misc
    ymEdit: false,
    myNurseId: localStorage.getItem('ns_my_nurse') || '',
    myOnly: false,
    rdMyPick: false,             // 폰 '내 근무' 카드의 이름 고르기 칩 열림
    fontPref: localStorage.getItem('ns_font') || '',
    rdConfirmKey: null, _rdConfirmTimer: null,
    signalPop: false,
    cellPop: {left: 0, top: 0},
    rdDoneAt: null, rdSaved: false,
    rdRelocked: {},              // "되돌려서 잠금" 누른 칸 — {nid|dk: true}
    rdFontOptions: [
      {v:'', label:'Pretendard (기본)'}, {v:'noto', label:'Noto Sans KR'}, {v:'nanum', label:'나눔고딕'},
      {v:'plex', label:'IBM Plex Sans KR'}, {v:'malgun', label:'맑은 고딕 (윈도우 기본)'},
    ],

    // ── 초기화 (프로필 열린 뒤 _initApp 끝에서) ──
    rdInit(){
      this.setFontPref(this.fontPref, true);
      this._rdTipInit();
      if(!window._rdPrintBound){ window._rdPrintBound = true;
        window.addEventListener('beforeprint', () => { if(this.showPrintPreview) document.body.classList.add('rd-printing'); });
        window.addEventListener('afterprint', () => document.body.classList.remove('rd-printing'));
        document.addEventListener('scroll', () => { if(this.shiftEdit.open) this.rdPlacePopup(); }, true);
        document.addEventListener('mousedown', e => { if(!this.shiftEdit.open) return; const t=e.target; if(t.closest&&(t.closest('.rpop')||t.closest('[data-cell]')||t.closest('.modal-bg')||t.closest('.rmodal-bg'))) return; this.shiftEdit.open=false; }, true);
      }
    },
    setFontPref(v, silent){
      this.fontPref = v || '';
      if(this.fontPref) document.documentElement.dataset.font = this.fontPref; else delete document.documentElement.dataset.font;
      try { localStorage.setItem('ns_font', this.fontPref); } catch(e) {}
      if(!silent) this.toast('글꼴을 바꿨습니다', 'info');
    },

    // 셀 팝업이 열린 동안 키보드 입력 — 팝업 힌트('D E N V O 로 바로 입력 · Del 지우기')가 약속하는 동작.
    // 전역 keydown 은 팝업이 열리면 격자 입력을 건너뛰므로 여기서 같은 표를 쓴다 (단일·다중 선택 공용).
    rdPopupKey(e){
      const se=this.shiftEdit; if(!se.open||se.mode==='schedule') return;
      const t=document.activeElement; if(t&&(['INPUT','TEXTAREA','SELECT'].includes(t.tagName)||t.isContentEditable)) return;
      if(e.ctrlKey||e.metaKey||e.altKey) return;
      const apply=code=>{ e.preventDefault(); this.applyShiftEditWithUndo(code); };
      if(e.key==='Delete'||e.key==='Backspace') return apply('__CLEAR__');
      const key=(e.key||'').toUpperCase();
      const code={D:'D',E:'E',N:'N',V:'V',O:'OF',W:'주'}[key]||{'ㅈ':'주','ㅂ':'병','ㅃ':'법','ㅅ':'생','ㅌ':'특','ㄱ':'공'}[e.key]||(this.shifts.find(s=>s.code.toUpperCase()===key)||{}).code;
      if(code) apply(code);
    },

    // ── 공통 ──
    get rdWard(){ return (this.profiles||[]).find(p=>p.id===this.currentProfile)?.name || '게스트'; },
    get rdCells(){
      return (this.nurses||[]).filter(n=>!n.is_trainee).length * ((this.scheduleDays||[]).filter(d=>!this.isOverflow(d)).length || 0);
    },
    get rdSched(){ return !!(this.schedule && Object.keys(this.schedule).length); },
    get rdRelaxedCount(){ return Object.keys(this.relaxedCells||{}).reduce((a,k)=>a+Object.keys(this.relaxedCells[k]||{}).length, 0); },
    rdCodeName(code){ const s=this.shiftMap.get(code); return CODE_NAME[code] || (s ? s.name : code); },
    rdShiftTip(code){
      const s=this.shiftMap.get(code); const name=this.rdCodeName(code);
      const hours=s && s.hours && s.hours!=='-' ? ' · '+s.hours : '';
      return `${name}${hours}`;
    },
    rdDayLabel(day){ return `${day.getMonth()+1}월 ${day.getDate()}일 (${WD[day.getDay()]})`; },
    rdFmtMD: fmtMD,
    rdWeekday(d){ return WD[d]; },
    rdEta(sec){ if(!sec) return '잠시'; return sec<90 ? `약 ${sec}초` : `약 ${Math.round(sec/60)}분`; },

    // ── 단계 바 부제 ("다음에 할 일") ──
    get rdStep(){
      const n=this.countPrevEntries();
      const sched=this.rdSched;
      let s3='만들고 인쇄';
      if(this.generating) s3='만드는 중…';
      else if(sched) s3=(this.rdRelaxedCount ? '완화로 생성' : '생성 완료')+(this.rdSaved ? ' · 저장됨' : '');   // 저장됨은 실제로 저장됐을 때만
      else if(!this.statusOk && this.statusMessage) s3='만들 수 없음';
      let s2='부족한 날 확인';
      if(this.analysisResult){ const danger=(this.analysisResult.warnings||[]).some(w=>w.type==='danger'); s2 = danger ? '부족한 날 있음' : '부족한 날 없음'; }
      return { gearDone: (this.nurses||[]).length>0, s1: n ? `${n}칸 입력됨` : '주휴·연차·희망 근무 넣기', s2, s3,
               done1: n>0, done2: !!this.analysisResult, done3: sched };
    },

    // ── 사전입력 신호등 한 줄 ──
    get rdSignal(){
      const n=this.countPrevEntries(), total=this.rdCells;
      if(!n) return {kind:'empty', dot:'none', text:'아직 비어 있어요 — 먼저 주휴를 넣거나', link:{label:'분석에서 주휴 추천 받기', act:'analysis'}};
      if((this.prevViolations||[]).length) return {kind:'fail', dot:'err', text:`이대로는 만들 수 없어요 — ${this.prevViolations[0].msg}`, link:{label:'자세히', act:'detail'}};
      const short=(this.staffingAlerts&&this.staffingAlerts.short)||[];
      if(short.length){
        const a=short[0];
        return {kind:'fail', dot:'err', text:`이대로는 만들 수 없어요 — ${fmtKo(a.dk)} 인원 ${a.needed-a.avail}명 부족`, link:{label:`${+a.dk.slice(8,10)}일 칸으로 가기`, act:'jump', dk:a.dk}};
      }
      const f=this.feas;
      if(f && f.checking && !f.status) return {kind:'checking', dot:'none', text:`만들 수 있는지 확인하는 중… · ${n} / ${total}칸 입력`, link:null};
      if(f && f.status==='infeasible'){
        const a=(f.anchored||[])[0];
        return {kind:'fail', dot:'err', text:`이대로는 만들 수 없어요 — ${a ? a.label : (f.message||'')}`, link: a ? {label:'칸으로 가기', act:'jumpA', a} : {label:'자세히', act:'detail'}};
      }
      const eta=f && f.estimated_seconds ? ` · 예상 ${this.rdEta(f.estimated_seconds)}` : '';
      if(f && f.status==='unknown') return {kind:'unknown', dot:'warn', text:`만들 수 있는지 5초 안에 판정하지 못했어요 (만들 때 확정) · ${n} / ${total}칸 입력`, link:null};
      if(f && f.status==='feasible') return {kind:'ok', dot:'ok', text:`지금 입력으로 만들 수 있어요${eta} · ${n} / ${total}칸 입력`, link:null};
      const tight=(this.staffingAlerts&&this.staffingAlerts.tight)||[];
      if(tight.length) return {kind:'tight', dot:'warn', text:`${fmtKo(tight[0].dk)}은 여유가 0명이에요. 휴가를 더 넣으면 부족해집니다. · ${n} / ${total}칸 입력`, link:null};
      return {kind:'ok', dot:'ok', text:`${n} / ${total}칸 입력`, link:null};
    },
    rdSignalAct(link){
      if(!link) return;
      if(link.act==='analysis') this.activeTab='analysis';
      else if(link.act==='jump') this.jumpToPreCell(null, link.dk);
      else if(link.act==='jumpA') this.jumpToPreCell(link.a.nurse_id, link.a.date);
      else if(link.act==='detail') this.signalPop=!this.signalPop;
    },
    get rdSignalDetailCount(){
      return (this.prevViolations||[]).length + (this.prevPinNotes||[]).length + (((this.feas||{}).anchored)||[]).length + (((this.staffingAlerts||{}).short)||[]).length;
    },

    // ── 근무표 상태 줄 ──
    get rdStatus(){
      if(this.generating){
        const rem=this.estimatedSeconds ? Math.max(0, this.estimatedSeconds-this.generateElapsed) : 0;
        const t = rem ? this.rdEta(rem)+' 남음' : (this.estimatedSeconds ? '예상보다 오래 걸리지만 멈춘 게 아니에요' : '잠시만요');
        return {kind:'warn', running:true, text:`근무표를 만드는 중… ${t}`};
      }
      if(!this.rdSched) return null;
      const rx=this.rdRelaxedCount;
      const pre=this.countPrevEntries();
      // gap(최적해와의 거리) 문장 — CP-SAT 가능해는 gap 이 수천 % 도 나오므로 숫자는 10% 안쪽일 때만 보여 준다
      const g=this.mipGapPercent;
      const q = this.scheduleStopped ? ' · 중간에 멈춰 지금까지 찾은 답' : (g==null ? '' : (g<=0.1 ? ' · 가장 좋은 답' : (g<=10 ? ` · 가장 좋은 답과 ${Math.round(g*10)/10}% 안쪽 차이` : ' · 시간 안에 찾은 답 (더 좋은 표가 있을 수 있어요)')));
      const at=this.rdDoneAt instanceof Date ? ` (${this.rdDoneAt.getMonth()+1}월 ${this.rdDoneAt.getDate()}일 ${String(this.rdDoneAt.getHours()).padStart(2,'0')}:${String(this.rdDoneAt.getMinutes()).padStart(2,'0')})` : '';
      const saved = this.rdSaved ? '만들어졌고 저장됐습니다' : '만들어졌습니다';
      if(rx) return {kind:'ok', relaxed:true, text:`근무표가 ${saved}${at} · 사전입력 ${rx}칸을 바꿔서 만들었어요${q}`};
      if(!this.statusOk && this.statusMessage) return {kind:'warn', text:`근무표는 있지만 확인이 필요해요 — 아래 요약·리포트의 생성 기록을 보세요`};
      return {kind:'ok', text:`근무표가 ${saved}${at} · 사전입력 ${pre}칸 모두 지켰어요${q}`};
    },
    get rdEdited(){ return this._originalSchedule ? this.getManualEditCount() : 0; },

    // ── 실패 배너 ──
    get rdFail(){
      if(this.generating || this.statusOk || !this.statusMessage || this.rdSched) return null;
      const short=((this.staffingAlerts||{}).short)||[];
      const anchored=[...(((this.diagResult||{}).anchored)||[]), ...(((this.feas||{}).anchored)||[])].filter(a=>a&&(a.nurse_id||a.date));
      const seen=new Set(); const fixes=[];
      for(const a of anchored){
        const key=`${a.nurse_id}|${a.date}`; if(seen.has(key)) continue; seen.add(key);
        const nurse=this.nurses.find(n=>n.id===a.nurse_id);
        const code=a.nurse_id && a.date ? (this.prevSchedule[a.nurse_id]||{})[a.date] : '';
        const label=nurse && a.date ? `${nurse.name} · ${fmtMD(a.date)}${code ? ' '+this.rdCodeName(code) : ''}` : a.label;
        fixes.push({kind:'cell', label, code, nid:a.nurse_id, iso:a.date});
        if(fixes.length>=3) break;
      }
      let title, body;
      if(short.length){
        const a=short[0]; const k=a.needed-a.avail;
        title=`${fmtKo(a.dk)} 근무 인원이 ${k}명 모자라 이 조건으로는 만들 수 없어요.`;
        body=`그날 나올 수 있는 사람은 ${a.avail}명인데 필요 인원은 ${a.needed}명입니다. 아래 셋 중 하나를 바꾸면 풀립니다.`;
        if(fixes.length<3){
          const req={...(this.requirements?.[['sun','mon','tue','wed','thu','fri','sat'][new Date(a.dk+'T00:00:00').getDay()]]||{}), ...(this.prevDayReqs?.[a.dk]||{})};
          const p=['D','E','N'].sort((x,y)=>(+req[y]||0)-(+req[x]||0))[0];
          const need=+req[p]||0;
          if(need>1) fixes.push({kind:'req', label:`${fmtMD(a.dk)} ${PERIOD_KO[p]} 필요 인원 ${need} → ${need-1}`, dk:a.dk, period:p});
        }
      }else{
        const first=(this.statusMessage||'').split('\n').map(s=>s.replace(/^[★⚠❌✗\s]+/,'').trim()).find(s=>s&&!/^[━─=]+/.test(s))||'';
        title=`이 조건으로는 만들 수 없어요.${first ? ' '+first.slice(0,80) : ''}`;
        body='아래에서 하나를 고치거나 사전입력 완화를 켜고 다시 만들어 보세요. 잠근 칸은 완화해도 바뀌지 않습니다.';
      }
      return {title, body, fixes: fixes.slice(0,3)};
    },
    rdApplyFix(f){
      if(f.kind==='cell') this.jumpToPreCell(f.nid, f.iso);
      else if(f.kind==='req'){
        const d=new Date(f.dk+'T00:00:00');
        const cur=this.getPrevDayReq(d,f.period); const base=this.getDefaultDayReq(d,f.period);
        const v=(cur!==null&&cur!==undefined)?cur:base;
        if(v<=1) return;
        this._pushUndo(); this.setPrevDayReq(d,f.period,v-1);
        this._checkViolations&&this._checkViolations();
        this.rdUndoToast(`${fmtMD(f.dk)} ${PERIOD_KO[f.period]} 필요 인원을 ${v-1}명으로 줄였습니다.`);
      }
    },
    rdRelaxAndRemake(){ this.allowPreRelax=true; this.generate(); },

    // ── 서랍 (요약·리포트) ──
    get rdDrawerTabs(){
      const rx=this.rdRelaxedCount;
      const w=(this.scheduleWarnings||[]).length;
      const wr=this.wishReport; const unmet=wr ? Math.max(0,(wr.total_requested||0)-(wr.total_granted||0)) : 0;
      return [
        {id:'summary', label:'요약', n:0, tip:'간호사별 야간·주말 수와 누적 편차'},
        {id:'relaxed', label:'원티드 미반영', n:rx, err:true, tip:'사전입력과 다르게 배정된 칸'},
        {id:'v', label:'연차(V) 설명', n:(this.vReport&&this.vReport.total)||0, tip:'연차가 왜 어디에 들어갔는지'},
        {id:'teukgeun', label:'오프특근', n:(this.offTeukgeun||[]).length, tip:'오프인데 근무로 잡힌 날'},
        {id:'warn', label:'주의', n:w, tip:'확인이 필요한 배정'},
        {id:'wish', label:'위시 반영', n:unmet, tip:'희망 근무가 얼마나 들어갔는지'},
        {id:'log', label:'생성 기록', n:0, tip:'계산 방식·시간·정확도'},
      ];
    },
    get rdDrawerBadge(){ return this.rdRelaxedCount + (this.offTeukgeun||[]).length + (this.scheduleWarnings||[]).length; },
    rdOpenDrawer(tab){ this.showReports=true; if(tab) this.reportTab=tab; },
    get rdRelaxedList(){
      const out=[];
      for(const [nid,cells] of Object.entries(this.relaxedCells||{})){
        const nurse=this.nurses.find(n=>n.id===nid); const name=nurse?nurse.name:nid;
        for(const [dk,info] of Object.entries(cells||{})){
          out.push({nid, dk, name, date:fmtKo(dk), from:info.original, to:info.assigned, note:(this.cellNotes?.[nid]?.[dk])||'', boost:(this.relaxBoosts||{})[nid]||0, locked:!!this.rdRelocked[nid+'|'+dk]});
        }
      }
      out.sort((a,b)=>(b.note?1:0)-(a.note?1:0));
      return out;
    },
    relockCell(nid, dk){
      const info=this.relaxedCells?.[nid]?.[dk]; if(!info) return;
      this._pushUndo();
      if(!this.prevSchedule[nid]) this.prevSchedule[nid]={};
      this.prevSchedule[nid][dk]=info.original;
      if(!this.lockedCells[nid]) this.lockedCells[nid]={};
      this.lockedCells[nid][dk]=true;
      this.rdRelocked={...this.rdRelocked, [nid+'|'+dk]:true};
      this._checkViolations&&this._checkViolations();
      const nurse=this.nurses.find(n=>n.id===nid);
      this.rdUndoToast(`${nurse?nurse.name:''} ${fmtMD(dk)} 칸을 ${info.original}(으)로 되돌리고 잠갔습니다. 다시 만들기를 누르세요.`);
    },
    get rdSummaryRows(){
      const rows=this.nurseSummaryData||[]; if(!rows.length) return [];
      const pool=rows.filter(r=>!r.exclN); const avg=pool.length ? pool.reduce((a,r)=>a+r.totalNights,0)/pool.length : 0;
      return rows.map(r=>{ const dev=r.exclN ? null : Math.round(r.totalNights-avg); return {...r, dev, devLabel: dev===null ? '※' : (dev>0?'+'+dev:String(dev)), devCls: dev===null?'':(dev>=2?'hi':(dev<=-2?'lo':''))}; });
    },

    // ── 저장 버튼 상태 ──
    get rdSaveLabel(){ return this.rdSched && this.rdSaved ? '저장됨' : '저장'; },
    get rdSaveTip(){ return this.rdSched ? (this.rdSaved ? '자동으로 저장됐습니다. 이름을 바꿔 따로 저장하려면 누르세요.' : '이 근무표를 이름 붙여 저장합니다.') : '만든 뒤에 저장할 수 있어요.'; },
    get rdMakeLabel(){ return this.generating ? '만드는 중…' : (this.rdSched ? '다시 만들기' : '근무표 만들기'); },
    get rdMakeTip(){ return this.rdSched ? '지금 표를 버리고 새로 만듭니다. 저장한 표는 불러오기에 남아 있어요.' : `사전입력을 지키면서 자동으로 채웁니다. ${this.feas&&this.feas.estimated_seconds ? this.rdEta(this.feas.estimated_seconds)+' 걸리고' : '몇 분 걸리고'} 중간에 멈출 수 있어요.`; },

    // ── 되돌리기 토스트 ──
    rdUndoToast(msg, undo=true){
      clearTimeout(this._rdToastTimer);
      this.rdToast={msg, undo};
      this._rdToastTimer=setTimeout(()=>{ this.rdToast=null; }, 6000);
    },
    rdToastUndo(){ if(this.rdToast&&this.rdToast.undo) this.undo(); this.rdToast=null; clearTimeout(this._rdToastTimer); },

    // ── 파괴적 동작 2단 확인 ──
    rdArm(key){
      if(this.rdConfirmKey===key){ this.rdConfirmKey=null; clearTimeout(this._rdConfirmTimer); return true; }
      this.rdConfirmKey=key; clearTimeout(this._rdConfirmTimer);
      this._rdConfirmTimer=setTimeout(()=>{ this.rdConfirmKey=null; }, 3500);
      return false;
    },
    rdArmed(key){ return this.rdConfirmKey===key; },
    rdClearPrev(){ if(this.rdArm('clearPrev')) this.clearPrevSchedule(true); },
    rdDeleteNurse(){
      const id=this.nurseModal.data.id; if(!id||this.nurseModal.isNew) return;
      const armed=this._removeConfirmId===id;
      this.removeNurse(id).then(()=>{ if(armed) this.nurseModal.open=false; });
    },

    // ── 숫자 ± ──
    bumpReq(key, shift, delta){
      if(!this.requirements[key]) this.requirements[key]={};
      const v=Math.max(0, Math.min(20, (parseInt(this.requirements[key][shift])||0)+delta));
      this.requirements[key][shift]=v;
    },
    bumpRule(field, delta, min, max){
      const v=Math.max(min, Math.min(max, (parseInt(this.rules[field])||0)+delta));
      this.rules[field]=v;
    },
    bumpTimeout(delta){ this.generateTimeout=Math.max(1, Math.min(60, (parseInt(this.generateTimeout)||20)+delta)); },

    // ── 셀 팝업 ──
    get rdPopCodes(){
      const mode=this.shiftEdit.mode;
      let codes=this.getEditShifts();
      if(mode==='prev') codes=this.allShifts.filter(c=>!c.startsWith('/'));
      if(this.shiftEdit.mode==='prev' && this.shiftEdit.nurse && this.isTraineeInTraining(this.shiftEdit.nurse, this.shiftEdit.day)) codes=this.traineeShifts;
      const bare=c=>c.replace(/^\//,'');
      const work=[], rest=[];
      for(const c of codes){ const s=this.shiftMap.get(bare(c)); const p=s?s.period:''; (['day','day1','evening','middle','night'].includes(p)?work:rest).push(c); }
      const ord=(arr,order)=>arr.sort((a,b)=>{ const ia=order.indexOf(bare(a)), ib=order.indexOf(bare(b)); return (ia<0?99:ia)-(ib<0?99:ib); });
      return {work:ord(work,WORK_ORDER), rest:ord(rest,REST_ORDER)};
    },
    get rdPopCurrent(){
      const n=this.shiftEdit.nurse, d=this.shiftEdit.day; if(!n||!d||this.shiftEdit.mode==='prev_multi') return '';
      return this.shiftEdit.mode==='prev' ? this.getPrevShift(n.id, d) : (this._getShift(n.id, d)||'');
    },
    rdPlacePopup(){
      const se=this.shiftEdit; if(!se.open||!se.nurse||!se.day) return;
      this.$nextTick(()=>{
        const nid=se.nurse.id||se.nurse.nid; const iso=this.dayKey(se.day);
        const el=document.querySelector(`.rd-screen:not([style*="display: none"]) [data-cell="${nid}|${iso}"]`)||document.querySelector(`[data-cell="${nid}|${iso}"]`);
        if(!el){ this.cellPop={left:24, top:96}; return; }
        // 팝업은 position:fixed — 칸의 뷰포트 좌표 기준 오른쪽에, 안 들어가면 왼쪽에, 아래가 모자라면 위로 올린다
        const r=el.getBoundingClientRect(), W=372, H=Math.min(470, window.innerHeight-16);
        let left=r.right+8, top=r.top-8;
        if(left+W>window.innerWidth-8) left=r.left-W-8;
        if(left<8) left=8;
        if(top+H>window.innerHeight-8) top=Math.max(8, window.innerHeight-H-8);
        this.cellPop={left:Math.round(left), top:Math.round(top)};
      });
    },
    rdPopPick(code){ if(this.shiftEdit.mode==='prev_multi') this.applyMultiShiftEdit(code); else this.applyShiftEditWithUndo(code); },
    rdCellTipPre(nurse, day){
      const inact=this.isNurseInactive(nurse, day); if(inact) return inact==='before' ? '전입 전 — 배정하지 않습니다' : '전출 후 — 배정하지 않습니다';
      const code=this.getPrevShift(nurse.id, day); const m=day.getMonth()+1, d=day.getDate();
      let t=code ? `${nurse.name} · ${m}월 ${d}일 ${code}(${this.rdCodeName(code)}) — 클릭해 바꾸거나 잠금·메모` : `${nurse.name} · ${m}월 ${d}일 — 클릭해 근무 선택 · 빈칸은 자동 배정`;
      if(this.isLocked(nurse.id, day)) t+=' · 잠긴 칸';
      const note=this.getNote(nurse.id, day); if(note) t+=' · 메모: '+note;
      if(!code && this.hasWish(nurse.id, day)) t+=' · 희망 '+this.getWish(nurse.id, day);
      return t;
    },
    rdCellTipSched(nurse, day){
      const inact=this.isNurseInactive(nurse, day); if(inact) return inact==='before' ? '전입 전' : '전출 후';
      const code=this.displayShift(nurse.id, day); const m=day.getMonth()+1, d=day.getDate();
      let t=`${nurse.name} · ${m}월 ${d}일 ${code||'(빈칸)'} — 클릭해 고치기`;
      if(this.isLocked(nurse.id, day)) t+=' · 잠긴 칸';
      if(this.isRelaxed(nurse.id, day)) t+=` · 사전입력 ${this.relaxedCells[nurse.id][this.dayKey(day)].original}에서 바뀜`;
      const note=this.getNote(nurse.id, day); if(note) t+=' · 메모: '+note;
      return t;
    },

    // ── 요일별 인원 / 규칙 표시 ──
    rdReqVal(key, shift){ return (this.requirements[key]||{})[shift]||0; },
    rdFootNeed(day, code){ const r=this.getPrevDayReq(day, code); return (r!==null&&r!==undefined) ? r : this.getDefaultDayReq(day, code); },

    // ── 간호사 모달 보조 ──
    rdWdays: ['일','월','화','수','목','금','토'],
    rdJuhuIs(i){ return this.nurseModal.data.juhu_day===i; },
    rdToggleJuhuDay(i){ this.nurseModal.data.juhu_day = this.nurseModal.data.juhu_day===i ? null : i; },
    rdMonthOn(m){ return !!(this.nurseModal.data.night_months||{})[`${this.year}-${String(m).padStart(2,'0')}`]; },
    rdToggleMonth(m){ this.toggleNightMonthModal(m, !this.rdMonthOn(m)); },
    rdCapable(s){ return !!(this.nurseModal.data.capable_shifts||[]).includes(s); },
    get rdSpecialSummary(){
      const d=this.nurseModal.data||{}; const p=[];
      if(d.is_trainee) p.push('신규간호사');
      if(d.is_pregnant) p.push('임산부');
      if(d.start_date||d.end_date) p.push('전입/전출');
      return p.length ? `— ${p.join(' · ')}` : '— 신규간호사 · 임산부 · 전입/전출 (해당 없음)';
    },
    rdSpecialOpen: false,
    nurseNote(nurse){
      const p=[];
      if(nurse.is_trainee){ const pr=this.nurses.find(n=>n.id===nurse.preceptor_id); p.push('신규'+(pr?' · 프리셉터 '+pr.name:'')); }
      if(nurse.is_pregnant) p.push('임산부 · 야간 제외');
      if(nurse.start_date) p.push(`${fmtMD(nurse.start_date)} 전입`);
      if(nurse.end_date) p.push(`${fmtMD(nurse.end_date)} 전출`);
      return p.join(' · ');
    },
    rdNk(nurse){
      const b=this.nightMonthsBadge(nurse);
      if(b.on) return {label:`${this.month}월 켜짐`, cls:'on', title:b.title};
      if(b.any){ const t=b.text.replace(' 야간전담','').replace(/월$/,'월만'); return {label:t, cls:'other', title:b.title}; }
      return {label:'—', cls:'', title:b.title};
    },

    // ── 인쇄 미리보기 ──
    get rdPrintDays(){ return (this.scheduleDays||[]).filter(d=>!this.isOverflow(d)); },
    rdPrintCode(nurse, day){ return this.displayShift(nurse.id, day); },
    rdDoPrint(){ document.body.classList.add('rd-printing'); setTimeout(()=>{ this.printSchedule(); setTimeout(()=>document.body.classList.remove('rd-printing'), 1500); }, 60); },
    get rdPrintMeta(){
      const today=new Date(); const ds=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      return `간호사 ${this.nurses.length}명 · 작성 ${ds} · D 06~14 · E 14~22 · N 22~06 · 주=주휴 · OF=오프 · V=연차`;
    },

    // ── 폰: 내 근무 · 오늘 근무자 ──
    setMyNurse(id){ this.myNurseId=id||''; try{ localStorage.setItem('ns_my_nurse', this.myNurseId); }catch(e){} },
    get rdMyShift(){
      const n=this.nurses.find(x=>x.id===this.myNurseId); if(!n) return null;
      const k=this.todayKey(); const code=(this.schedule?.[n.id]?.[k])||'';
      const s=this.shiftMap.get(code);
      const desc = code ? (({day:'낮',day1:'상근',evening:'저녁',middle:'중간번',night:'야간',rest:'휴무',leave:'휴가'})[s?.period]||'')+(s&&s.hours&&s.hours!=='-' ? ' '+s.hours.replace(/:00/g,'') : '') : '오늘 근무표에 없음';
      const nx=[]; const d=new Date();
      for(let i=1;i<=2;i++){ const t=new Date(d); t.setDate(d.getDate()+i); const c=(this.schedule?.[n.id]?.[this.dayKey(t)])||''; if(c) nx.push((i===1?'내일 ':'그다음 ')+c+' '+this.rdCodeName(c)); }
      return {name:n.name, code: code||'—', desc, next: nx.join(' · ')};
    },
    get rdTodayDuties(){
      return ['D','E','N'].map(duty=>{
        const rows=this.todayNursesByDuty(duty);
        return {code:duty, name: duty==='D'?'낮 06~14':duty==='E'?'저녁 14~22':'야간 22~06', count: rows.length+'명',
                people: rows.map(r=>({name:r.nurse.name, charge:['DC','EC','NC'].includes(r.code)}))};
      });
    },
    get rdTodayCount(){ return ['D','E','N'].reduce((a,d)=>a+this.todayNursesByDuty(d).length, 0); },
    get rdPhoneNurses(){ const list=this.filteredNurses; return this.myOnly && this.myNurseId ? list.filter(n=>n.id===this.myNurseId) : list; },

    // ── 커스텀 툴팁 (title 을 읽어 0.3초 뒤 표시, 포커스에도) ──
    _rdTipInit(){
      if(window._rdTipBound) return; window._rdTipBound=true;
      const tip=document.createElement('div'); tip.className='rtip'; tip.hidden=true; tip.setAttribute('role','tooltip'); document.body.appendChild(tip);
      let timer=null, cur=null;
      const fmt=t=>{ const parts=String(t).trim().split(/(?<=[.。])\s+/).filter(Boolean); if(parts.length>=2){ const last=parts.pop(); return esc(parts.join(' '))+' <span class="note">'+esc(last)+'</span>'; } return esc(t); };
      const place=el=>{ const r=el.getBoundingClientRect(); tip.style.left='0px'; tip.style.top='0px'; const tw=Math.min(380, tip.offsetWidth||380);
        let left=r.left+window.scrollX-24; if(left+tw>window.innerWidth-12) left=window.innerWidth-12-tw; if(left<8) left=8;
        let top=r.bottom+window.scrollY+8; if(top+tip.offsetHeight>window.innerHeight+window.scrollY-8) top=r.top+window.scrollY-tip.offsetHeight-8;
        tip.style.left=left+'px'; tip.style.top=top+'px'; };
      const show=el=>{ const t=el.getAttribute('title'); if(!t) return; el.setAttribute('data-rd-tip', t); el.removeAttribute('title'); cur=el; tip.innerHTML=fmt(t); tip.hidden=false; place(el); };
      const hide=()=>{ clearTimeout(timer); timer=null; if(cur){ const t=cur.getAttribute('data-rd-tip'); if(t&&!cur.getAttribute('title')) cur.setAttribute('title', t); cur.removeAttribute('data-rd-tip'); } cur=null; tip.hidden=true; };
      document.addEventListener('mouseover', e=>{ const el=e.target.closest&&e.target.closest('[title]'); if(!el){ return; } if(el===cur) return; hide(); timer=setTimeout(()=>show(el), 300); });
      document.addEventListener('mouseout', e=>{ const el=e.target.closest&&e.target.closest('[title],[data-rd-tip]'); if(!el) return; if(e.relatedTarget&&el.contains(e.relatedTarget)) return; hide(); });
      document.addEventListener('focusin', e=>{ const el=e.target.closest&&e.target.closest('[title]'); if(!el) return; hide(); show(el); });
      document.addEventListener('focusout', ()=>hide());
      document.addEventListener('mousedown', ()=>hide(), true);
      document.addEventListener('keydown', e=>{ if(e.key==='Escape') hide(); });
      window.addEventListener('scroll', ()=>hide(), true);
    },

    // ── 검증용 상태 진입 (design/handoff/check) — 개발·검증에서만 쓴다 ──
    async rdApplyState(screen, state){
      if(this.profileScreen){ const g=(this.profiles||[]).find(p=>p.is_guest)||(this.profiles||[])[0]; if(g){ this.profilePasswordInput=''; await this.selectProfile(g); } }
      // 서버에 남은 직전 생성 결과 복원(_checkPendingGenerate, 비동기)이 픽스처보다 늦게 도착하면 상태를 덮어쓴다 — 먼저 끝나기를 기다린다
      try{ await this._checkPendingGenerate(); }catch(e){}
      if(this._recoverPoll){ clearInterval(this._recoverPoll); this._recoverPoll=null; }
      this.showOnboarding=false; this.showHelpModal=false; this.showShortcutHelp=false; this.showMobileMore=false; this.showPrintPreview=false;
      this.shiftEdit.open=false; this.pastePrev.open=false; this.nurseModal.open=false; this.noteEdit.open=false; this.juhuOptionModal.open=false;
      this.showSavedDrawer=false; this.signalPop=false; this.rdToast=null; this.rdMyPick=false; this.showGenAdvanced=false; this.tableFullscreen=false;
      this.year=2026; this.month=10; this.holidays=['2026-10-03','2026-10-09'];
      const fx=this._rdFixtures();
      const setPrev=filled=>{ this.prevSchedule=filled?fx.prev:{}; this.lockedCells=filled?fx.locks:{}; this.cellNotes=filled?fx.notes:{}; this.feas=filled?{status:'feasible',estimated_seconds:180,checking:false,anchored:[],conflicts:[]}:null; this.staffingAlerts=null; this.prevViolations=[]; this.prevPinNotes=[]; };
      const setSched=(kind)=>{
        this.generating=false; this.diagResult=null; this.fixResult=null; this.scheduleStopped=false; this.mipGapPercent=1.2;
        if(kind==='none'){ this.schedule={}; this.extendedSchedule={}; this.relaxedCells={}; this.statusMessage=''; this.statusOk=true; this._originalSchedule=null; this.showReports=false; return; }
        this.schedule=JSON.parse(JSON.stringify(fx.sched)); this.extendedSchedule={}; this.nurseScores={}; this.nurseScoreDetails={};
        this.relaxedCells={}; this.statusOk=true; this.statusMessage='근무표 생성 완료'; this.rdDoneAt=new Date(2026,8,28,14,2); this.rdSaved=true;
        this.offTeukgeun=[]; this.vReport=null; this.wishReport=null; this.generationReport=null; this.solverLogs=[];
        this.trackEdits();
        for(const [nid,dk] of fx.edited){ this.schedule[nid][dk]= this.schedule[nid][dk]==='D' ? 'E' : 'D'; }
        this.lockedCells=fx.schedLocks;
        if(kind==='relaxed'){
          this.relaxedCells={};
          for(const r of fx.relax){ (this.relaxedCells[r.nid]=this.relaxedCells[r.nid]||{})[r.dk]={original:r.from, assigned:r.to}; this.schedule[r.nid][r.dk]=r.to; }
          this.cellNotes={[fx.relax[0].nid]:{[fx.relax[0].dk]:'이날 낮 인원이 1명 모자람'}};
          this._originalSchedule=JSON.parse(JSON.stringify(this.schedule));
          this.offTeukgeun=[{name:this.nurses[2].name,week:2,start:'2026-10-04',end:'2026-10-10'},{name:this.nurses[5].name,week:3,start:'2026-10-11',end:'2026-10-17'}];
          this.showReports=true; this.reportTab='relaxed';
        }else{ this.showReports=false; this.reportTab='summary'; }
      };
      if(screen==='preinput'){
        this.activeTab='preinput'; setSched('none');
        const st=state||'filled';
        setPrev(st!=='empty');
        await this.$nextTick();
        if(st==='menu'){ await new Promise(r=>setTimeout(r,120)); const b=document.querySelector('[data-rd=btn-import]'); if(b) b.click(); }
        if(st==='popup'){ const n=this.nurses[0]; const day=new Date(2026,9,7); this.openPrevEdit(n, day); this.focusCell(0, 10); this.rdPlacePopup(); }
        if(st==='paste'){ this.openPastePrev(); }
        if(st==='toast'||st==='filled'){ this.rdToast={msg:'위시 시트 17명 · 42칸을 넣었습니다.', undo:true}; }
      }else if(screen==='schedule'){
        this.activeTab='schedule'; setPrev(true);
        const st=state||'success';
        if(st==='before') setSched('none');
        else if(st==='running'){ setSched('none'); this.generating=true; this.estimatedSeconds=180; this.generateElapsed=30; this.statusMessage=''; }
        else if(st==='failed'){
          setSched('none'); this.statusOk=false;
          this.statusMessage='★ 10/03(토) D 인원 부족: 필요 4명, 가용 3명\n사전입력을 확인하세요.';
          this.staffingAlerts={short:[{dk:'2026-10-03',needed:12,avail:11}],tight:[]};
          this.prevSchedule[this.nurses[0].id]['2026-10-03']='V'; this.prevSchedule[this.nurses[3].id]['2026-10-03']='주';
          this.diagResult={anchored:[{label:'김지현 10/3 V',nurse_id:this.nurses[0].id,date:'2026-10-03'},{label:'정수아 10/3 주',nurse_id:this.nurses[3].id,date:'2026-10-03'}]};
        }
        else if(st==='relaxed') setSched('relaxed');
        else setSched('success');
        if(st==='print'){ this.showPrintPreview=true; }
        const dark=(st==='dark'); if(this.darkMode!==dark){ this.darkMode=dark; document.documentElement.classList.toggle('dark', dark); }
      }else if(screen==='settings'){
        this.activeTab='settings'; setSched('none'); setPrev(true); this.settingsSection='roster';
        if(state==='modal'){ this.openNurseModal(this.nurses[0]); this.rdSpecialOpen=false; }
      }else if(screen==='phone'){
        this.activeTab='today'; setPrev(true); setSched('success');
        const k=this.todayKey(); this.nurses.forEach((n,i)=>{ (this.schedule[n.id]=this.schedule[n.id]||{})[k]=['E','D','N','OF','D','E'][i%6]; });
        this.setMyNurse(this.nurses[0].id);
      }
      if(screen!=='schedule' && this.darkMode){ this.darkMode=false; document.documentElement.classList.remove('dark'); }
      await this.$nextTick(); await new Promise(r=>setTimeout(r, 300));
      return true;
    },
    _rdFixtures(){
      const nurses=this.nurses; const days=this.scheduleDays; const dk=d=>this.dayKey(d);
      const hol=new Set(this.holidays);
      const prev={}, locks={}, notes={};
      nurses.forEach((n,i)=>{ const row={};
        for(let w=0;w<5;w++){ const idx=w*7+((i*3)%7); if(idx<days.length) row[dk(days[idx])]='주'; }
        if(i%4===1) row[dk(days[8+i%5])]='V';
        if(i%5===2) row[dk(days[16+i%4])]='생';
        if(i%6===3){ row[dk(days[22])]='N'; row[dk(days[23])]='N'; }
        if(i===0){ row[dk(days[10])]='V'; row[dk(days[11])]='V'; }
        if(i===2) row[dk(days[13])]='특';
        if(i===7) row[dk(days[19])]='공';
        days.forEach(d=>{ const k=dk(d); if(hol.has(k)&&!row[k]) row[k]='법'; });
        prev[n.id]=row; });
      if(nurses[0]) locks[nurses[0].id]={[dk(days[10])]:true,[dk(days[11])]:true};
      if(nurses[7]) locks[nurses[7].id]={[dk(days[19])]:true};
      if(nurses[2]) notes[nurses[2].id]={[dk(days[13])]:'가족 여행'};
      const base=['주','N','OF','D','E','N','D','E','N','OF','D','E','N','D','E','N','OF','D','E','N','D','E','N','OF','D','E','N','D','E','N','OF','D'];
      const sched={};
      nurses.forEach((n,i)=>{ const row={};
        days.forEach((d,k)=>{ let code = k<3 ? base[(30+k-i+32)%32] : base[((k-3-i)%32+32)%32]; const key=dk(d);
          if(hol.has(key)&&k>=3&&i%3===0) code='법';
          if(i===0&&(k===13||k===14)) code='V';
          row[key]=code; });
        sched[n.id]=row; });
      const at=(i,k)=>[nurses[i]?nurses[i].id:null, dk(days[k])];
      const edited=[at(0,20),at(3,21)].filter(x=>x[0]);
      const schedLocks={}; for(const [nid,k] of [at(0,13),at(0,14),at(7,22)]){ if(nid) (schedLocks[nid]=schedLocks[nid]||{})[k]=true; }
      const relax=[[1,15,'주','D'],[4,9,'OF','E'],[10,22,'V','N']].filter(r=>nurses[r[0]]).map(([i,k,from,to])=>({nid:nurses[i].id, dk:dk(days[k]), from, to}));
      return {prev, locks, notes, sched, edited, schedLocks, relax};
    },
  };
};
