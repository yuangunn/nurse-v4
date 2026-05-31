/* ────────────────────────────────────────────────────────────────────────────
 * 기타 기능 — 변경 이력·그룹 필터·생성 경고 요약·다크모드 자동전환·배점 슬라이더·토스트·스케줄 위반 체크·분석 자동실행·온보딩·섹션 접기·교차 표시·작업 복원·PDF·드래그 정렬·공정성 대시보드
 *
 * 사용: app() 반환 객체에 `...MiscFeaturesModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.MiscFeaturesModule = function() {
  return {
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
      // 주말 공평성 규칙이 없으면 생성은 안 하고 안내만
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
        this.year=d.y;this.month=d.m;this.activeTab=d.tab||'settings';
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
