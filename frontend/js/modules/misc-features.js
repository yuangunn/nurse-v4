/* ────────────────────────────────────────────────────────────────────────────
 * 기타 기능 — 변경 이력·그룹 필터·생성 경고 요약·다크모드 자동전환·배점 슬라이더·토스트·스케줄 위반 체크·분석 자동실행·온보딩·섹션 접기·교차 표시·작업 복원·PDF·드래그 정렬·공정성 대시보드
 *
 * 사용: app() 반환 객체에 `...MiscFeaturesModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.MiscFeaturesModule = function() {
  return {
    // ═══ 한국 공휴일 자동 계산 (음력 = KASI 한국천문연구원 기준) ═══════════
    // 고정 양력 공휴일 + 음력 공휴일(설날·추석·부처님오신날) + 대체공휴일을 매년 규칙으로 산출.
    // 음력은 순수 공식 변환이 불가능하므로 KASI 음력 기준일(설날 음1/1·부처님 음4/8·추석 음8/15)을
    // 양력으로 내장(_LUNAR)하고 그 위에서 연휴 확장·대체공휴일을 계산한다.
    // 대체공휴일 규칙(2023 개정): 설날·추석=일요일/타공휴일 겹침만, 그 외(삼일절·어린이날·광복절·
    // 개천절·한글날·성탄절·부처님오신날)=토·일/타공휴일 겹침, 신정·현충일=대체 없음.
    _LUNAR:{  // year: [설날 음1/1, 부처님 음4/8, 추석 음8/15] 양력 MM-DD
      2025:['01-29','05-05','10-06'], 2026:['02-17','05-24','09-25'], 2027:['02-07','05-13','09-15'],
      2028:['01-27','05-02','10-03'], 2029:['02-13','05-20','09-22'], 2030:['02-03','05-09','09-12'],
      2031:['01-23','05-28','10-01'], 2032:['02-11','05-16','09-19'], 2033:['01-31','05-06','09-08'],
      2034:['02-19','05-25','09-27'], 2035:['02-08','05-15','09-16'], 2036:['01-28','05-03','10-04'],
      2037:['02-15','05-22','09-24'], 2038:['02-04','05-11','09-13'], 2039:['01-24','04-30','10-02'],
      2040:['02-12','05-18','09-21'], 2041:['02-01','05-07','09-10'], 2042:['01-22','05-26','09-28'],
      2043:['02-10','05-16','09-17'], 2044:['01-30','05-05','10-05'], 2045:['02-17','05-24','09-25'],
      2046:['02-06','05-13','09-15'], 2047:['01-26','05-02','10-04'], 2048:['02-14','05-20','09-22'],
      2049:['02-02','05-09','09-11'], 2050:['01-23','05-28','09-30'],
    },
    // 선거일·임시공휴일 — 규칙으로 계산 불가, 수동 등록 (자동계산 결과에 합산)
    _HOLIDAY_SPECIAL:{
      2026:['2026-06-03'],   // 제9회 전국동시지방선거
    },
    _lunarRange(){ const ys=Object.keys(this._LUNAR).map(Number); return [Math.min(...ys),Math.max(...ys)]; },
    // 해당 연도 전체 공휴일(대체공휴일·특별공휴일 포함) 양력 ISO 배열. 범위 밖이면 null.
    _computeKRHolidays(year){
      const anchor=this._LUNAR[year];
      if(!anchor) return null;
      const SUN=0, SAT=6, DAY=86400000;
      const D=(y,m,d)=>new Date(Date.UTC(y,m-1,d));
      const iso=dt=>dt.toISOString().slice(0,10);
      const add=(dt,n)=>new Date(dt.getTime()+n*DAY);
      const SATSUN=new Set(['삼일절','어린이날','광복절','개천절','한글날','성탄절','부처님오신날']); // 토·일 대체
      const SUNONLY=new Set(['설날','추석']);                                                       // 일요일만 대체
      const byDate=new Map();  // ISO -> Set(공휴일명)
      const put=(dt,nm)=>{ const k=iso(dt); if(!byDate.has(k))byDate.set(k,new Set()); byDate.get(k).add(nm); };
      [[1,1,'신정'],[3,1,'삼일절'],[5,5,'어린이날'],[6,6,'현충일'],[8,15,'광복절'],[10,3,'개천절'],[10,9,'한글날'],[12,25,'성탄절']]
        .forEach(([m,d,nm])=>put(D(year,m,d),nm));
      const mk=s=>D(year, +s.slice(0,2), +s.slice(3,5));
      const seollal=mk(anchor[0]), buddha=mk(anchor[1]), chuseok=mk(anchor[2]);
      [-1,0,1].forEach(k=>put(add(seollal,k),'설날'));
      [-1,0,1].forEach(k=>put(add(chuseok,k),'추석'));
      put(buddha,'부처님오신날');
      const base=new Set(byDate.keys());
      const subs=new Set();
      const nextFree=dt=>{ let nd=add(dt,1); while(base.has(iso(nd))||subs.has(iso(nd))||nd.getUTCDay()===SUN||nd.getUTCDay()===SAT) nd=add(nd,1); return nd; };
      for(const k of [...byDate.keys()].sort()){
        const names=byDate.get(k);
        const elig=[...names].some(n=>SATSUN.has(n)||SUNONLY.has(n));
        if(!elig) continue;
        const dt=D(+k.slice(0,4),+k.slice(5,7),+k.slice(8,10));
        const wd=dt.getUTCDay();
        let lost=0;
        if(wd===SUN || (wd===SAT && [...names].some(n=>SATSUN.has(n)))) lost++;   // 주말 손실
        if(names.size>=2) lost+=names.size-1;                                      // 타공휴일 겹침
        for(let i=0;i<lost;i++) subs.add(iso(nextFree(dt)));
      }
      const special=this._HOLIDAY_SPECIAL[year]||[];
      return [...new Set([...base,...subs,...special])].sort();
    },
    autoFillHolidays(){
      // 주기 범위(전월 말·익월 초 패딩 포함) 전체를 채운다 — 서버도 주기 범위의
      // 공휴일만 인정하므로, 월경계 주에 걸린 익월 공휴일(신정·설날·삼일절)이
      // 빠지면 그 날에 OF가 배정되고 오프특근 판정도 어긋난다.
      const days=this.scheduleDays;
      const years=[...new Set(days.map(d=>d.getFullYear()))];
      const table=[];let missing=false;
      for(const y of years){const t=this._computeKRHolidays(y);if(t)table.push(...t);else missing=true}
      if(!table.length){
        const [lo,hi]=this._lunarRange();
        this.toast(`${years.join('·')}년 공휴일 자동계산 불가 — 내장 음력 데이터는 ${lo}~${hi}년만 지원합니다. 날짜 헤더 우클릭으로 직접 지정하세요`,'warn',6000);return;
      }
      const inRange=new Set(days.map(d=>this.dayKey(d)));
      const target=table.filter(h=>inRange.has(h)&&!this.holidays.includes(h));
      if(!target.length){this.toast('이 주기에 추가할 공휴일이 없습니다 (이미 모두 입력됨)','info');return}
      this._pushUndo();
      this.holidays=[...this.holidays,...target];
      this._checkViolations&&this._checkViolations();
      const label=target.map(h=>+h.slice(5,7)+'/'+ +h.slice(8)).join(', ');
      const warn=missing?' (일부 연도는 음력 데이터 범위 밖 — 직접 확인하세요)':'';
      this.toast(`🇰🇷 공휴일 ${target.length}일 입력: ${label} — 임시공휴일·변경은 직접 확인하세요${warn}`,'info',5000);
    },

    // ═══ 전월N 자동 인수인계 ═════════════════════════════
    async autoFillPrevMonthNights(){
      try{
        const r=await this.api('GET',`/api/prev_month_nights?year=${this.year}&month=${this.month}`);
        const ids=Object.keys(r||{});
        if(!ids.length){this.toast('직전 달 저장 근무표가 없습니다 — 저장 탭에서 전월 확정본을 먼저 저장해 두면 자동 계산됩니다','warn',5000);return}
        this.prevMonthNights={...this.prevMonthNights,...r};
        this.toast(`🌙 전월N ${ids.length}명 자동 입력 (직전 달 저장본의 N/NC 집계)`,'info',4000);
      }catch(e){this.toast('전월N 자동 계산 실패','error')}
    },

    // ═══ 공정성 원장 (직전 3개월 누적) ════════════════════
    async loadFairnessLedger(){
      try{
        const r=await this.api('GET',`/api/fairness_ledger?year=${this.year}&month=${this.month}`);
        this.fairnessLedger3m=r.ledger||{};
      }catch(e){this.fairnessLedger3m={}}
    },

    // ═══ 11. 변경 이력 ════════════════════════════════════
    changeHistory:[],
    _maxHistory:100,
    addHistory(action,detail){
      this.changeHistory.unshift({time:new Date().toLocaleTimeString(),action,detail});
      if(this.changeHistory.length>this._maxHistory)this.changeHistory.pop();
    },

    // ═══ 12. 간호사 그룹별 필터 ══════════════════════════
    groupFilter:'all',
    // 단체 수정/직접 입력에서 항상 보여줄 그룹 후보 — 현재 사용 중 + 누적 history + 표준 [A,B,C]
    _rememberGroup(g){
      g=(g||'').trim();
      if(!g)return;
      let history=[];
      try{const raw=localStorage.getItem('nurseGroupHistory');if(raw)history=JSON.parse(raw)||[]}catch(e){}
      if(!history.includes(g)){
        history.push(g);
        try{localStorage.setItem('nurseGroupHistory',JSON.stringify(history))}catch(e){}
      }
    },

    // ═══ 13. 생성 결과 경고 요약 ═════════════════════════

    // ═══ 14. 다크모드 자동 전환 ══════════════════════════
    autoDarkMode:false,
    initAutoDark(){
      if(!window.matchMedia)return;
      const mq=window.matchMedia('(prefers-color-scheme: dark)');
      if(localStorage.getItem('autoDarkMode')==='true'){
        this.autoDarkMode=true;
        this.darkMode=mq.matches;
        document.documentElement.classList.toggle('dark',this.darkMode);
      }
      mq.addEventListener('change',e=>{
        if(this.autoDarkMode){this.darkMode=e.matches;document.documentElement.classList.toggle('dark',this.darkMode)}
      });
    },
    toggleAutoDark(){
      this.autoDarkMode=!this.autoDarkMode;
      localStorage.setItem('autoDarkMode',this.autoDarkMode);
      if(this.autoDarkMode){
        const mq=window.matchMedia('(prefers-color-scheme: dark)');
        this.darkMode=mq.matches;
        document.documentElement.classList.toggle('dark',this.darkMode);
      }
    },

    // ═══ 배점 슬라이더 시스템 ═════════════════════════════
    scoringSliders:{
      continuity:5,    // 근무 연속성 0~10
      forward:5,       // 순방향 전환 0~10
      nightFairness:5, // 야간 공평성 0~10
      weekendFairness:5,// 주말 공평성 0~10
      wishWeight:5,    // 희망 반영도 0~10
    },
    showScoringSliders:false,
    _initScoringSliders(){
      try{const raw=localStorage.getItem('ns_scoring_sliders');if(raw)this.scoringSliders=JSON.parse(raw)}catch(e){}
    },
    _saveScoringSliders(){
      try{localStorage.setItem('ns_scoring_sliders',JSON.stringify(this.scoringSliders))}catch(e){}
    },
    applyScoringSliders(){
      // 슬라이더 값을 기존 scoringRules의 점수에 반영
      const s=this.scoringSliders;
      const map={
        // rule name → {slider, base, multiplier}
        '연속 동일 근무 보상':{slider:s.continuity, base:15, field:'score'},
        '순방향 D→E':{slider:s.forward, base:20, field:'score'},
        '순방향 E→N':{slider:s.forward, base:20, field:'score'},
        'D→N 전환 페널티':{slider:s.forward, base:-30, field:'score'},
        '야간 공평성':{slider:s.nightFairness, base:-10, field:'score'},
        '야간 근무 공평성':{slider:s.nightFairness, base:-50, field:'score'},          // 시드 이름
        '주말·공휴일 근무 공평성':{slider:s.weekendFairness, base:-30, field:'score'}, // M6 P3②
        '희망 근무 반영':{slider:s.wishWeight, base:50, field:'score'},
        '연속 휴일 보상':{slider:s.continuity, base:30, field:'score'},
      };
      let updated=0;
      for(const rule of this.scoringRules){
        const m=map[rule.name];
        if(m){
          const newScore=Math.round(m.base*(m.slider/5));
          if(rule.score!==newScore){rule.score=newScore;updated++}
        }
      }
      this._saveScoringSliders();
      if(updated>0)this.toast(`배점 ${updated}건 조정됨`,'info');
      // 서버에 저장
      for(const rule of this.scoringRules){
        this.api('POST','/api/scoring_rules',rule).catch(()=>{});
      }
    },

    // ═══ 토스트 알림 시스템 ══════════════════════════════
    _toasts:[],
    _toastId:0,
    _toastHistory:[],  // 최근 20개 보관
    showToastHistory:false,
    toast(msg,type='info',duration=3000){
      const id=++this._toastId;
      const ts=new Date().toLocaleTimeString('ko-KR',{hour12:false});
      this._toasts.push({id,msg,type,ts});
      this._toastHistory.unshift({id,msg,type,ts});
      if(this._toastHistory.length>20)this._toastHistory.pop();
      if(type!=='loading'){
        setTimeout(()=>{this._toasts=this._toasts.filter(t=>t.id!==id)},duration);
      }
      return id;  // loading 토스트 해제용
    },
    dismissToast(id){this._toasts=this._toasts.filter(t=>t.id!==id)},

    // ═══ 스케줄 탭 제약 위반 체크 ═════════════════════════
    scheduleViolations:[],
    checkScheduleViolations(){
      const v=[];
      const days=this.scheduleDays;
      const dayNames=['일','월','화','수','목','금','토'];
      const eveningCodes=this.shifts.filter(s=>s.period==='evening'||s.period==='middle').map(s=>s.code);
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const dayCodes=this.shifts.filter(s=>s.period==='day'||s.period==='day1').map(s=>s.code);
      for(const nurse of this.nurses){
        const nid=nurse.id;
        for(let i=0;i<days.length-1;i++){
          const dk1=this.dayKey(days[i]),dk2=this.dayKey(days[i+1]);
          const s1=(this.schedule[nid]||{})[dk1],s2=(this.schedule[nid]||{})[dk2];
          if(!s1||!s2)continue;
          const d1=days[i].getDate(),dn1=dayNames[days[i].getDay()];
          const d2=days[i+1].getDate(),dn2=dayNames[days[i+1].getDay()];
          if(eveningCodes.includes(s1)&&dayCodes.includes(s2))
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (E→D)`});
          if(nightCodes.includes(s1)&&dayCodes.includes(s2))
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (N→D)`});
          if(nightCodes.includes(s1)&&eveningCodes.includes(s2))
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (N→E)`});
        }
      }
      this.scheduleViolations=v;
    },
    hasScheduleViolation(nurseId,day){return this.scheduleViolations.some(v=>v.nid===nurseId&&v.dk===this.dayKey(day))},

    // ═══ 분석 탭 자동실행 ═════════════════════════════════
    _lastAnalysisKey:'',
    autoRunAnalysis(){
      const key=`${this.year}-${this.month}-${this.countPrevEntries()}`;
      if(key!==this._lastAnalysisKey){this._lastAnalysisKey=key;this.runAnalysis()}
    },

    // ═══ 온보딩 + 도움말 ════════════════════════════════════
    showShortcutHelp:false,
    showOnboarding:false,
    onboardingStep:0,
    showHelpModal:false,
    helpTab:'workflow',

    checkFirstRun(){
      if(!localStorage.getItem('ns_onboarding_done')){
        this.showOnboarding=true;
        this.onboardingStep=0;
      }
    },
    finishOnboarding(){
      this.showOnboarding=false;
      localStorage.setItem('ns_onboarding_done','1');
    },
    nextOnboarding(){
      if(this.onboardingStep>=6)this.finishOnboarding();
      else this.onboardingStep++;
    },
    prevOnboarding(){
      if(this.onboardingStep>0)this.onboardingStep--;
    },

    // ═══ 설정 탭 섹션 접기 ════════════════════════════════
    settingsCollapse:{yearMonth:false,requirements:false,shifts:false,rules:false,nurses:false},
    toggleSection(key){this.settingsCollapse[key]=!this.settingsCollapse[key]},

    // ═══ 사전입력 ↔ 스케줄 교차 표시 ═════════════════════
    isPrevMatched(nurseId,day){
      const dk=this.dayKey(day);
      const pre=(this.prevSchedule[nurseId]||{})[dk];
      const sched=(this.schedule[nurseId]||{})[dk];
      if(!pre||!sched)return null;
      if(pre===sched)return'match';
      const flex=this._getPreFlex(pre);
      if(flex.includes(sched))return'match';
      return'changed';
    },
    _getPreFlex(code){
      const map={'D':['D','DC'],'E':['E','EC'],'N':['N','NC']};
      return map[code]||[code];
    },

    // ═══ 최근 작업 복원 확장 ══════════════════════════════
    _saveFullState(){
      try{
        localStorage.setItem('ns_full_state',JSON.stringify({
          y:this.year,m:this.month,tab:this.activeTab,
          ps:this.prevSchedule,dr:this.prevDayReqs,hd:this.holidays,
          lk:this.lockedCells,nt:this.cellNotes,mn:this.prevMonthNights,
          t:Date.now()
        }));
      }catch(e){}
    },
    _restoreFullState(){
      try{
        const raw=localStorage.getItem('ns_full_state');
        if(!raw)return false;
        const d=JSON.parse(raw);
        if(Date.now()-d.t>172800000)return false; // 48시간 초과 무시
        if(Object.keys(this.prevSchedule).some(k=>Object.keys(this.prevSchedule[k]).length>0))return false;
        this.year=d.y;this.month=d.m;this.activeTab=d.tab||'preinput';
        this.prevSchedule=d.ps||{};this.prevDayReqs=d.dr||{};this.holidays=d.hd||[];
        this.lockedCells=d.lk||{};this.cellNotes=d.nt||{};this.prevMonthNights=d.mn||{};
        return true;
      }catch(e){return false}
    },

    // ═══ PDF 내보내기 (인쇄 기반) ═════════════════════════
    exportToPDF(){
      // 인쇄 다이얼로그를 열어 PDF로 저장 안내
      this.toast('인쇄 대화상자에서 "PDF로 저장"을 선택하세요','info',4000);
      setTimeout(()=>window.print(),500);
    },

    // ═══ 간호사 순서 드래그 정렬 ═════════════════════════
    _dragNurseIdx:null,
    onNurseDragStart(idx){this._dragNurseIdx=idx},
    onNurseDragOver(idx,event){event.preventDefault()},
    onNurseDrop(idx){
      if(this._dragNurseIdx===null||this._dragNurseIdx===idx)return;
      const moved=this.nurses.splice(this._dragNurseIdx,1)[0];
      this.nurses.splice(idx,0,moved);
      this._dragNurseIdx=null;
      // 서버에 순서 저장
      this.api('POST','/api/nurses/reorder',{order:this.nurses.map(n=>n.id)}).catch(()=>{});
      this.toast('간호사 순서가 변경되었습니다','info');
    },

    // ═══ 8. 공정성 대시보드 (간이 버전) ══════════════════

  };
};
