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
    // 병원 휴일 — 매년 같은 날 쉬는 병원 자체 휴일 (2026-10-03 101병동 확인). 법정공휴일처럼 '법'으로 쉰다.
    // 기본값은 여기, 병동이 고친 목록은 rules.hospitalHolidays (설정 → 규칙 → 병원 휴일).
    // _computeKRHolidays 에 넣지 않는다 — KASI 골든셋 비교 대상이 아니고, 대체공휴일도 만들지 않는다.
    _HOSPITAL_HOLIDAYS_DEFAULT:[
      {md:'05-01',name:'근로자의 날'},{md:'05-09',name:'의료원 설립일'},
      {md:'07-17',name:'제헌절'},{md:'07-21',name:'노조 설립일'},
    ],
    // 그 해 병원 휴일 ISO 배열 (MM-DD 형식이 아니거나 없는 날짜는 건너뜀). 빈 목록이면 병원 휴일 없음.
    _hospitalHolidays(year){
      const list=this.rules?.hospitalHolidays ?? this._HOSPITAL_HOLIDAYS_DEFAULT;
      const out=[];
      for(const h of list||[]){
        const md=String(h?.md??'').trim();
        if(!/^[0-9]{2}-[0-9]{2}$/.test(md))continue;
        const m=+md.slice(0,2), d=+md.slice(3,5);
        const dt=new Date(Date.UTC(year,m-1,d));
        if(dt.getUTCMonth()!==m-1||dt.getUTCDate()!==d)continue;
        out.push(`${year}-${md}`);
      }
      return [...new Set(out)].sort();
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
      const hosp=[];   // 병원 휴일 — 음력 데이터와 상관없이 매년 채운다
      for(const y of years){const t=this._computeKRHolidays(y);if(t)table.push(...t);else missing=true;hosp.push(...this._hospitalHolidays(y))}
      if(!table.length){
        const [lo,hi]=this._lunarRange();
        this.toast(`${years.join('·')}년 공휴일 자동계산 불가 — 내장 음력 데이터는 ${lo}~${hi}년만 지원합니다. 날짜 헤더 우클릭으로 직접 지정하세요`,'warn',6000);
        if(!hosp.length)return;
      }
      const inRange=new Set(days.map(d=>this.dayKey(d)));
      const krSet=new Set(table);
      const target=[...new Set([...table,...hosp])].sort().filter(h=>inRange.has(h)&&!this.holidays.includes(h));
      if(!target.length){this.toast('이 주기에 추가할 공휴일이 없습니다 (이미 모두 입력됨)','info');return}
      const nHosp=target.filter(h=>!krSet.has(h)).length;
      this._pushUndo();
      this.holidays=[...this.holidays,...target];
      this._checkViolations&&this._checkViolations();
      const label=target.map(h=>+h.slice(5,7)+'/'+ +h.slice(8)).join(', ');
      const warn=missing?' (일부 연도는 음력 데이터 범위 밖 — 직접 확인하세요)':'';
      const hospNote=nHosp?` (병원 휴일 ${nHosp}일 포함)`:'';
      this.toast(`🇰🇷 공휴일 ${target.length}일 입력${hospNote}: ${label} — 임시공휴일·변경은 직접 확인하세요${warn}`,'info',5000);
      this.rdUndoToast&&this.rdUndoToast(`공휴일 ${target.length}일을 채웠습니다.`);
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
      const middleSet=new Set(this.shifts.filter(s=>s.period==='middle').map(s=>s.code));
      const day1Set=new Set(this.shifts.filter(s=>s.period==='day1').map(s=>s.code));
      const softTr=(this.rules||{}).rareTransitionLastResort!==false;
      for(const nurse of this.nurses){
        const nid=nurse.id;
        for(let i=0;i<days.length-1;i++){
          const dk1=this.dayKey(days[i]),dk2=this.dayKey(days[i+1]);
          const s1=(this.schedule[nid]||{})[dk1],s2=(this.schedule[nid]||{})[dk2];
          if(!s1||!s2)continue;
          const d1=days[i].getDate(),dn1=dayNames[days[i].getDay()];
          const d2=days[i+1].getDate(),dn2=dayNames[days[i+1].getDay()];
          if(eveningCodes.includes(s1)&&dayCodes.includes(s2)){
            // E→D1·중→D 는 마지막 수단(제1원칙 13) — 위반 표시가 아니라 서랍 '주의'의 파트장 확인 필요로 알린다
            const rule=`${middleSet.has(s1)?'중':'E'}→${day1Set.has(s2)?'D1':'D'}`;
            if(softTr&&(rule==='E→D1'||rule==='중→D'))continue;
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (${rule})`});
          }
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
      if(this.isFlexWish(pre))return this.flexAllows(pre,sched)?'match':'changed';
      const flex=this._getPreFlex(pre);
      if(flex.includes(sched))return'match';
      return'changed';
    },
    _getPreFlex(code){
      const map={'D':['D','DC'],'E':['E','EC'],'N':['N','NC']};
      return map[code]||[code];
    },

    // ═══ 최근 작업 복원 확장 ══════════════════════════════
    // 사전입력·필요 인원·공휴일·잠금·메모·전월N 을 병동(프로필)마다 키 하나('ns_full_state:<id>')에 — 30초마다·창 닫을 때·병동 바꾸기 전.
    // 늘 마지막 것 하나라 다시 열면 가장 새 것이 열린다. _lsPid = 지금 화면에 깔린 것이 어느 병동 것인가 — 프로필을 열고 복원하기 전·
    // 프로필 고르는 화면·게스트는 null 이라 쓰지 않는다. 예전엔 병동 구분 없는 키 둘이라 다른 병동 것이 깔리고, 창 닫을 때만 쓰는 낡은 것이
    // 30초 자동 보관보다 먼저 열리고, 프로필 화면에서 닫으면 빈 상태가 덮었다 (2026-10-21)
    _lsPid:null,
    _saveFullState(){
      if(!this._lsPid||this.profileScreen)return;
      try{
        localStorage.setItem('ns_full_state:'+this._lsPid,JSON.stringify({
          y:this.year,m:this.month,tab:this.activeTab,
          ps:this.prevSchedule,dr:this.prevDayReqs,hd:this.holidays,
          lk:this.lockedCells,nt:this.cellNotes,mn:this.prevMonthNights,
          t:Date.now()
        }));
      }catch(e){}
    },
    _restoreFullState(){
      const pid=this.currentProfile;
      this._lsPid=(this.profiles||[]).some(p=>p.id===pid&&p.is_guest)?null:pid;   // 게스트는 '종료 시 데이터 삭제' — 보관하지 않는다
      if(!this._lsPid)return false;
      try{
        const raw=localStorage.getItem('ns_full_state:'+pid);
        const d=raw?JSON.parse(raw):this._legacyFullState();
        if(!d)return false;
        if(Object.keys(this.prevSchedule).some(k=>Object.keys(this.prevSchedule[k]).length>0))return false;
        this.year=d.y;this.month=d.m;this.activeTab=d.tab||'preinput';
        this.prevSchedule=d.ps||{};this.prevDayReqs=d.dr||{};this.holidays=d.hd||[];
        this.lockedCells=d.lk||{};this.cellNotes=d.nt||{};this.prevMonthNights=d.mn||{};
        return true;
      }catch(e){return false}
    },
    // 예전 판의 병동 구분 없는 키 둘 — 그 사전입력의 사람이 이 병동 명부에 있으면 더 새 것을 한 번 이어받고 지운다 (판 올림에 작업을 잃지 않게)
    _legacyFullState(){
      const keys=['ns_full_state','ns_prev_autosave'];
      const d=keys.map(k=>{try{return JSON.parse(localStorage.getItem(k))}catch(e){return null}}).filter(x=>x&&x.ps).sort((a,b)=>(b.t||0)-(a.t||0))[0];
      if(!d||!Object.keys(d.ps).some(id=>(this.nurses||[]).some(n=>n.id===id)))return null;
      for(const k of keys)localStorage.removeItem(k);
      return d;
    },

    // ═══ PDF 내보내기 (인쇄 기반) ═════════════════════════
    exportToPDF(){
      // 인쇄 다이얼로그를 열어 PDF로 저장 안내
      this.toast('인쇄 대화상자에서 "PDF로 저장"을 선택하세요','info',4000);
      setTimeout(()=>window.print(),500);
    },

    // ═══ 간호사 순서 드래그 정렬 ═════════════════════════
    // 순서 칸을 끌어 놓기 — 끈 사람이 골라져 있으면 고른 사람 모두를 지금 순서대로 함께 옮긴다.
    // 아래로 끌면 놓은 줄 뒤에, 위로 끌면 앞에 (한 명일 때와 같다).
    _dragNurseIdx:null,
    _dropNurseIdx:null,
    onNurseDragStart(idx){this._dragNurseIdx=idx},
    onNurseDragOver(idx,event){event.preventDefault();if(this._dragNurseIdx!==null)this._dropNurseIdx=idx},
    onNurseDragEnd(){this._dragNurseIdx=null;this._dropNurseIdx=null},
    rdDropCls(idx){
      const f=this._dragNurseIdx;
      return f===null||this._dropNurseIdx!==idx||f===idx?'':f<idx?'drop-after':'drop-before';
    },
    onNurseDrop(idx){
      const from=this._dragNurseIdx;
      this.onNurseDragEnd();
      if(from===null||from===idx)return;
      const sel=this.selectedNurseMap,dragged=this.nurses[from],target=this.nurses[idx];
      const group=sel[dragged.id]?this.nurses.filter(n=>sel[n.id]):[dragged];
      if(group.includes(target))return;
      const rest=this.nurses.filter(n=>!group.includes(n));
      rest.splice(rest.indexOf(target)+(from<idx?1:0),0,...group);
      this.nurses.splice(0,this.nurses.length,...rest);
      // 순서 = 시니어리티 (결정 1-5) — 엔진의 차지 선임 규칙은 seniority 값을 본다. 서버는 ids 를 읽는다
      // (예전엔 {order} 로 보내 아무것도 저장되지 않고, 이 값도 그대로라 차지가 옛 순서로 갔다 — 2026-10-21)
      this.nurses.forEach((n,i)=>{n.seniority=i});
      this.api('POST','/api/nurses/reorder',{ids:this.nurses.map(n=>n.id)}).catch(()=>this.toast('간호사 순서를 저장하지 못했습니다 — 다시 옮겨 주세요','error'));
      this.toast(group.length>1?`${group.length}명 순서를 함께 옮겼어요`:'간호사 순서가 변경되었습니다','info');
    },

    // ═══ 8. 공정성 대시보드 (간이 버전) ══════════════════

  };
};
