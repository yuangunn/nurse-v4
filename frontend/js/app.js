function app() {
  return {
    // ── 상태 ──────────────────────────────────────────────────
    tabs: [
      {id:'settings', label:'설정'},
      {id:'preinput', label:'사전입력'},
      {id:'analysis', label:'분석'},
      {id:'schedule', label:'스케줄'},
      {id:'assign',   label:'어싸인'},
      {id:'saved',    label:'저장'},
    ],
    activeTab: 'settings',
    fontSize: parseInt(localStorage.getItem('fontSize'))||18,
    year:  new Date().getMonth()===11 ? new Date().getFullYear()+1 : new Date().getFullYear(),
    month: (new Date().getMonth()+1)%12+1,
    nurses: [],
    requirements: {
      mon:{DC:1,D:2,EC:1,E:2,NC:1,N:2},tue:{DC:1,D:2,EC:1,E:2,NC:1,N:2},
      wed:{DC:1,D:2,EC:1,E:2,NC:1,N:2},thu:{DC:1,D:2,EC:1,E:2,NC:1,N:2},
      fri:{DC:1,D:2,EC:1,E:2,NC:1,N:2},sat:{DC:1,D:1,EC:1,E:1,NC:1,N:1},
      sun:{DC:1,D:1,EC:1,E:1,NC:1,N:1},
    },
    rules: {
      weeklyOff:true, noNOD:true, avoidDN:true,
      maxConsecutiveWork:true, maxConsecutiveWorkDays:5,
      maxConsecutiveNight:true, maxConsecutiveNightDays:3,
      restAfterNight:true, restAfterNightDays:2, restAfterNightMinConsec:2,
      maxNightPerMonth:true, maxNightPerMonthCount:6,
      maxNightTwoMonth:false, maxNightTwoMonthCount:11,
      patternOptimization:true, autoMenstrualLeave:true, maxVPerMonth:1,
      preBonusLeave:5000, preBonusWork:500, preBonusRest:300,
    },
    schedule:{}, extendedSchedule:{},
    generating:false, generateStartTime:null, generateElapsed:0, generateFinalElapsed:0,
    generateTimer:null, sseSource:null, solverLogs:[], showLogPanel:false,
    solveProgress:{gap_percent:null,nodes:0,has_solution:false,is_running:false},
    stopRequested:false, mipGap:0.02, generateTimeout:20, allowPreRelax:false, allowJuhuRelax:false, unlimitedV:false, relaxedCells:{},
    generationReport:null, showGenReport:false, wishReport:null, showWishReport:false,
    staffingAlerts:null, fairnessLedger3m:null,
    solver:'highs', diagnosing:false, fixing:false, diagResult:null, fixResult:null,
    tableFullscreen:false,
    mipGapPercent:null, scheduleStopped:false, estimatedSeconds:0,
    statusMessage:'', statusOk:true, savedSchedules:[],
    darkMode: localStorage.getItem('darkMode')==='true',
    weekdayLabels:{mon:'월',tue:'화',wed:'수',thu:'목',fri:'금',sat:'토',sun:'일'},
    // workShifts removed (use allWorkShifts computed instead)
    shifts:[], shiftMgmtOpen:false, scoringRuleOpen:false,
    shiftModal:{open:false,isNew:true,data:{}},
    scoringRules:[], scoringMgmtOpen:false,
    scoringModal:{open:false,isNew:true,data:{}},
    prevSchedule:{}, prevDayReqs:{}, prevMonthNights:{},
    nurseScores:{}, nurseScoreDetails:{},
    scoreDetailModal:{open:false,nurseName:'',rows:[],total:0},
    holidays:[],
    prevSaves:[], prevSavePanel:false, prevSaveName:'',
    nurseModal:{open:false,isNew:true,data:{}},
    shiftEdit:{open:false,nurse:null,day:null,dateLabel:'',mode:'schedule'},
    _logSeq:0,
    analysisResult:null, juhuRecommendation:null, analysisRunning:false,
    // ── 사전입력 향상 기능 ──
    _undoStack:[], _redoStack:[], _maxUndo:40,
    _autoSaveTimer:null, _autoSaveKey:'ns_prev_autosave',
    prevViolations:[], _violationSet:new Set(),
    _dragStart:null, _dragCells:[], _isDragging:false,
    _focusedCell:null, // {nIdx, dIdx}
    lockedCells:{}, // nurseId → {dateKey: true}
    cellNotes:{},   // nurseId → {dateKey: 'text'}
    showNotes:false, noteEdit:{open:false,nurseId:'',dk:'',text:''},
    presetPanel:false,
    copySource:null, // nurseId
    juhuOptionModal:{open:false,nurse:null,day:null},

    // ── 프로필 시스템 ──
    profileScreen:true,   // 프로필 선택 화면 표시 여부
    profiles:[],
    currentProfile:null,
    hasMasterPassword:false,
    appVersion:'v4.1.0',

    // ── Stepper (Phase 3 — Clinical Paper appbar) ──
    get stepperDone(){
      const sched = this.schedule && Object.keys(this.schedule).length>0;
      return {
        settings: (this.nurses||[]).length > 0,
        preinput: this.countPrevEntries() > 0,
        analysis: !!this.analysisResult,
        schedule: sched,
        assign: !!this.assignData,
        saved: false,
      };
    },
    get stepperSummary(){
      const nurseN = (this.nurses||[]).length;
      const prevN = this.countPrevEntries();
      const totalCells = (this.nurses||[]).filter(n=>!n.is_trainee).length *
                         (this.scheduleDays?.filter(d=>!this.isOverflow(d))?.length || 0);
      const warns = (this.scheduleWarnings||[]).length;
      const sched = this.schedule && Object.keys(this.schedule).length>0;
      const savedN = (this.savedList||[]).length;
      return {
        settings: nurseN ? `${nurseN}명 · 규칙` : '명부 · 규칙',
        preinput: totalCells ? `${prevN} / ${totalCells} 셀` : '주휴 · 연차 입력',
        analysis: this.analysisResult ? (warns ? `경고 ${warns}건` : '인원 분석 완료') : '인원 과부족',
        schedule: this.generating ? 'solving…' :
                  (sched ? (this.mipGapPercent!=null ? `gap ${this.mipGapPercent.toFixed(1)}%` : '생성 완료')
                         : 'MIP 솔버'),
        assign: this.assignData ? '병실 배정됨' : '병실 자동 배정',
        saved: savedN ? `${savedN}건 저장됨` : 'CSV · 인쇄',
      };
    },

    profileCreateModal:{open:false,id:'',name:'',password:'',passwordConfirm:''},
    profilePasswordInput:'',
    profileMasterInput:'',
    profileError:'',
    profileDeleteConfirm:null,
    profileChangePwModal:{open:false,id:'',oldPw:'',newPw:'',newPwConfirm:''},

    // ── 개발자 모드 ──
    developerMode:false,
    _devModeUnlocked:localStorage.getItem('devMode')==='true',
    _versionClickTimestamps:[],
    devSettingsOpen:false,
    devMasterPw:'',
    devMasterPwConfirm:'',
    devDbInfo:null, // DB 경로/크기
    showHospitalLogo:localStorage.getItem('showHospitalLogo')==='true', // 기본 숨김
    toggleHospitalLogo(){
      this.showHospitalLogo=!this.showHospitalLogo;
      localStorage.setItem('showHospitalLogo',this.showHospitalLogo);
    },

    // ── UX 개선 ──
    showPreBonusSettings:false,     // 사전입력 완화 차등 보너스 설정 패널
    scheduleGenOptions:true,        // #5 모바일 옵션 접기
    showPrevHint:false,             // #3 이전달 이월 힌트
    generatePhase:'',               // #12 진행단계 ('building'|'solving'|'extracting'|'done')
    showAnalysisPanel:false,         // 사전입력 내 분석 패널
    analysisWarnings:[],            // #7 분석 경고 요약
    resetConfirmStep:0,             // #14 초기화 2단계

    // ── computed ──────────────────────────────────────────────
    get traineeShifts(){
      // /D, /E, /N, /주, /OF, /D1 + 여성이면 /생
      const base=['/D','/E','/N','/주','/OF','/D1'];
      if(this.shiftEdit.nurse?.gender==='female')base.push('/생');
      return base;
    },
    get presets(){
      return [
        {name:'주말 OFF',desc:'토/일을 OF로 설정',apply:(nid)=>{
          this._pushUndo();
          for(const d of this.scheduleDays){if(d.getDay()===0||d.getDay()===6){if(!this.prevSchedule[nid])this.prevSchedule[nid]={};this.prevSchedule[nid][this.dayKey(d)]='OF'}}
          this._checkViolations();
        }},
        {name:'주휴 자동',desc:'주휴 4주 순환 배분',apply:(nid)=>{
          const nurse=this.nurses.find(n=>n.id===nid);
          if(nurse){
            const firstSat=this.scheduleDays.find(d=>d.getDay()===6);
            if(firstSat)this.autoFillJuhu(nurse,firstSat);
          }
        }},
        {name:'야간전담',desc:'모든 근무일을 N으로',apply:(nid)=>{
          this._pushUndo();
          for(const d of this.scheduleDays){
            const dk=this.dayKey(d);
            const existing=(this.prevSchedule[nid]||{})[dk];
            if(!existing||existing===''){if(!this.prevSchedule[nid])this.prevSchedule[nid]={};this.prevSchedule[nid][dk]='N'}
          }
          this._checkViolations();
        }},
        {name:'전체 초기화',desc:'이 간호사의 사전입력 삭제',apply:(nid)=>{
          this._pushUndo();
          const keys=this._cycleDateKeys();
          if(this.prevSchedule[nid]){for(const k of keys)delete this.prevSchedule[nid][k]}
          this._checkViolations();
        }},
      ];
    },
    get nurseSummaryData(){
      if(!this.schedule||!Object.keys(this.schedule).length)return[];
      const dayCodes=this.shifts.filter(s=>s.period==='day').map(s=>s.code);
      const eveCodes=this.shifts.filter(s=>s.period==='evening').map(s=>s.code);
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const restCodes=this.shifts.filter(s=>s.period==='rest').map(s=>s.code);
      const leaveCodes=this.shifts.filter(s=>s.period==='leave').map(s=>s.code);
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      const offCodes=[...restCodes,...leaveCodes];
      return this.nurses.map(nurse=>{
        const nid=nurse.id;
        const sc=this.schedule[nid]||{};
        let d=0,e=0,n=0,rest=0,leave=0,weekendWork=0;
        // 휴무의 질 — 고립 휴무(양옆이 근무인 하루짜리)와 최장 연속 휴무.
        // OF 개수가 같아도 쪼개진 휴무와 이틀 연속은 체감이 다르다.
        let isolatedOff=0,maxOffRun=0,offRun=0;
        const seq=days.map(day=>sc[this.dayKey(day)]||'');
        for(let i=0;i<days.length;i++){
          const day=days[i];const val=seq[i];if(!val)continue;
          if(dayCodes.includes(val))d++;
          else if(eveCodes.includes(val))e++;
          else if(nightCodes.includes(val))n++;
          else if(restCodes.includes(val))rest++;
          else if(leaveCodes.includes(val))leave++;
          if((day.getDay()===0||day.getDay()===6)&&[...dayCodes,...eveCodes,...nightCodes].includes(val))weekendWork++;
          if(offCodes.includes(val)){
            offRun++;maxOffRun=Math.max(maxOffRun,offRun);
            const prevOff=i>0&&offCodes.includes(seq[i-1]);
            const nextOff=i<days.length-1&&offCodes.includes(seq[i+1]);
            if(!prevOff&&!nextOff&&i>0&&i<days.length-1&&seq[i-1]&&seq[i+1])isolatedOff++;
          }else offRun=0;
        }
        const cum=this.fairnessLedger3m?.[nid];
        return{name:nurse.name,group:nurse.group,d,e,n,rest,leave,weekendWork,total:d+e+n,
               isolatedOff,maxOffRun,
               cumNights:cum?cum.nights:null,cumWeekends:cum?cum.weekends:null,
               score:this.nurseScores[nid]??0};
      });
    },
    get filteredNurses(){
      if(this.groupFilter==='all')return this.nurses;
      return this.nurses.filter(n=>n.group===this.groupFilter);
    },
    get nurseGroups(){
      const groups=[...new Set(this.nurses.map(n=>n.group).filter(Boolean))];
      return groups.sort();
    },
    get nurseGroupChoices(){
      let history=[];
      try{const raw=localStorage.getItem('nurseGroupHistory');if(raw)history=JSON.parse(raw)||[]}catch(e){}
      const merged=[...new Set([...this.nurseGroups,...history,'A','B','C'])].filter(Boolean);
      return merged.sort();
    },
    get scheduleWarnings(){
      if(!this.schedule||!Object.keys(this.schedule).length)return[];
      const warns=[];
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const workCodes=this.shifts.filter(s=>['day','day1','evening','middle','night'].includes(s.period)).map(s=>s.code);
      const dayNames=['일','월','화','수','목','금','토'];

      for(const nurse of this.nurses){
        const nid=nurse.id;
        // 연속 근무 체크
        let consec=0,maxConsec=0;
        for(const day of days){
          const val=this.schedule[nid]?.[this.dayKey(day)];
          if(val&&workCodes.includes(val)){consec++;maxConsec=Math.max(maxConsec,consec)}
          else consec=0;
        }
        if(maxConsec>=6)warns.push({type:'warn',nurse:nurse.name,msg:`연속 ${maxConsec}일 근무`});

        // 야간 편중
        const nCount=Object.values(this.schedule[nid]||{}).filter(v=>nightCodes.includes(v)).length;
        if(nCount>=8)warns.push({type:'warn',nurse:nurse.name,msg:`야간 ${nCount}회 (편중)`});

        // 주말 근무 편중
        let weekendWork=0;
        for(const day of days){
          if(day.getDay()!==0&&day.getDay()!==6)continue;
          const val=this.schedule[nid]?.[this.dayKey(day)];
          if(val&&workCodes.includes(val))weekendWork++;
        }
        if(weekendWork>=6)warns.push({type:'info',nurse:nurse.name,msg:`주말 근무 ${weekendWork}회`});
      }
      return warns;
    },
    get fairnessData(){
      if(!this.schedule||!Object.keys(this.schedule).length)return null;
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const workCodes=this.shifts.filter(s=>['day','day1','evening','middle','night'].includes(s.period)).map(s=>s.code);
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      const stats=this.nurses.map(nurse=>{
        const nid=nurse.id;
        let nights=0,weekends=0,holidays=0;
        for(const day of days){
          const dk=this.dayKey(day);
          const val=this.schedule[nid]?.[dk];if(!val)continue;
          if(nightCodes.includes(val))nights++;
          if((day.getDay()===0||day.getDay()===6)&&workCodes.includes(val))weekends++;
          if(this.holidays.includes(dk)&&workCodes.includes(val))holidays++;
        }
        return{name:nurse.name,group:nurse.group,nights,weekends,holidays,score:this.nurseScores[nid]??0};
      });
      const avgNights=stats.reduce((s,n)=>s+n.nights,0)/stats.length;
      const avgWeekends=stats.reduce((s,n)=>s+n.weekends,0)/stats.length;
      return{stats,avgNights:avgNights.toFixed(1),avgWeekends:avgWeekends.toFixed(1)};
    },
    selectedNurseMap:{},
    get selectedNurseIds(){return Object.keys(this.selectedNurseMap)},
    get selectedNurseCount(){return this.selectedNurseIds.length},
    get allNursesSelected(){
      return this.nurses.length>0 && this.nurses.every(n=>this.selectedNurseMap[n.id]);
    },
    get shiftMap(){const m=new Map();for(const s of this.shifts)m.set(s.code,s);return m},
    get allWorkShifts(){return this.shifts.filter(s=>['day','evening','middle','night'].includes(s.period)).map(s=>s.code)},
    // 요일별 필요인원 행에 표시할 코드: D/E/N + auto_assign이고 D/E/N 그룹 외인 근무
    get reqShiftCodes(){
      const base=['D','E','N'];
      const grouped=new Set();
      this.shifts.filter(s=>['day','evening','night'].includes(s.period)).forEach(s=>grouped.add(s.code));
      const extra=this.shifts.filter(s=>s.auto_assign && !s.is_charge && !grouped.has(s.code) && !['rest','leave'].includes(s.period)).map(s=>s.code);
      return [...base,...extra];
    },
    // 사전입력 tfoot 행 데이터 (동적 — reqShiftCodes 기반)
    get reqFooterRows(){
      const lightMap={
        D:{bg:'#d9e9ff',bgLight:'#eaf4ff',color:'#1e40af'},
        E:{bg:'#d6f5e3',bgLight:'#eafaf0',color:'#166534'},
        N:{bg:'#ffe6c7',bgLight:'#fff4e4',color:'#9a4b00'},
      };
      const darkMap={
        D:{bg:'rgba(59,130,246,0.10)',bgLight:'rgba(59,130,246,0.04)',color:'#93c5fd'},
        E:{bg:'rgba(34,197,94,0.10)',bgLight:'rgba(34,197,94,0.04)',color:'#86efac'},
        N:{bg:'rgba(245,158,11,0.10)',bgLight:'rgba(245,158,11,0.04)',color:'#fcd34d'},
      };
      const colorMap=this.darkMode?darkMap:lightMap;
      const defaultColor=this.darkMode
        ?{bg:'rgba(255,255,255,0.04)',bgLight:'rgba(255,255,255,0.02)',color:'#94a3b8'}
        :{bg:'#e8e8f0',bgLight:'#f0f0f8',color:'#4b5563'};
      return this.reqShiftCodes.map(code=>({
        type:code,
        ...(colorMap[code]||defaultColor),
      }));
    },
    get allShifts(){return this.shifts.map(s=>s.code)},
    get prevShifts(){return this.shifts.filter(s=>!s.is_charge).map(s=>s.code)},
    get footerRows(){
      const d=this.shifts.filter(s=>s.period==='day').map(s=>s.code);
      const e=this.shifts.filter(s=>s.period==='evening').map(s=>s.code);
      const n=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const r=this.shifts.filter(s=>s.period==='rest').map(s=>s.code);
      return [{label:'D',shifts:d,color:'text-blue-700'},{label:'E',shifts:e,color:'text-green-700'},{label:'N',shifts:n,color:'text-amber-700'},{label:'휴무',shifts:r,color:'text-gray-600'}];
    },
    get periodGroups(){
      const base=[{value:'work',label:'모든 근무'},{value:'day',label:'낮 근무 (D, DC, D1)'},{value:'evening',label:'저녁 근무 (E, EC, 중)'},{value:'night',label:'야간 근무 (N, NC)'},{value:'rest',label:'휴무 (OF, 주)'},{value:'leave',label:'휴가 (V, 생, 특...)'},{value:'rest_leave',label:'휴무/휴가'},{value:'any',label:'전체'}];
      const specifics=this.shifts.map(s=>({value:`specific:${s.code}`,label:`특정: ${s.code} (${s.name})`}));
      return [...base,...specifics];
    },
    get scheduleDays(){
      // 주기(7일 블록) 단위로 확장: 1일이 속한 주기 시작 ~ 말일이 속한 주기 끝
      const first=new Date(this.year,this.month-1,1);
      const last=new Date(this.year,this.month,0);
      const ref=this._CYCLE_REF;const ms=86400000;
      const fo=Math.round((first-ref)/ms);let so=fo-((fo%7+7)%7);
      // 1일이 주기 경계와 일치하면 전월 중첩 0일 — 서버와 동일하게 한 주 확장해
      // 전월 말 기록(이월)이 월 경계 제약 검증에 쓰이게 한다
      if(((fo%7+7)%7)===0)so-=7;
      const lo=Math.round((last-ref)/ms);const eo=lo+(6-((lo%7+7)%7));
      const start=new Date(ref.getTime()+so*ms);const end=new Date(ref.getTime()+eo*ms);
      const days=[];let c=new Date(start);while(c<=end){days.push(new Date(c));c.setDate(c.getDate()+1)}
      return days;
    },
    isOverflow(day){return day.getMonth()!==this.month-1||day.getFullYear()!==this.year},
    isRelaxed(nurseId,day){return !!(this.relaxedCells[nurseId]&&this.relaxedCells[nurseId][this.dayKey(day)])},

    // ── init ──────────────────────────────────────────────────
    async init(){
      if(this.darkMode)document.documentElement.classList.add('dark');
      document.documentElement.style.fontSize=this.fontSize+'px';

      // 프로필 목록 로드 → 프로필 선택 화면 표시
      await this._loadProfiles();
      this.profileScreen=true;

      // 전역 키보드 단축키
      if(!window._nsKeydownBound){
        window._nsKeydownBound=true;
        document.addEventListener('keydown',(e)=>{
          if(this.profileScreen)return;
          if(e.key==='?'&&!e.ctrlKey&&!e.metaKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){this.showShortcutHelp=!this.showShortcutHelp;e.preventDefault();return}
          const _isTyping=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
          if(this.activeTab==='preinput'&&this._focusedCell&&!this.shiftEdit.open&&!this.noteEdit.open&&!this.juhuOptionModal.open&&!_isTyping){this.onGridKeyDown(e)}
          else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'&&this.activeTab==='preinput'&&!_isTyping){e.shiftKey?this.redo():this.undo();e.preventDefault()}
        });
      }
      window.addEventListener('beforeunload',()=>{this._saveFullState();this._closeCurrentProfile()});
      document.addEventListener('mouseup',()=>{if(this._isDragging)this.onCellMouseUp()});
      this._setupHeaderCondense();
      this.$nextTick(()=>{if(window.lucide)lucide.createIcons()});
    },

    // ── 적응형 헤더 축소 (활성 탭 스크롤 시 앱바 압축) ──────────
    _setupHeaderCondense(){
      if(window._nsCondenseBound)return;
      window._nsCondenseBound=true;
      const appbar=document.querySelector('.appbar');
      if(!appbar)return;
      // 스크롤은 버블링되지 않으므로 캡처 단계로 main-content 내부 스크롤을 모두 감지
      document.addEventListener('scroll',(e)=>{
        const t=e.target;
        if(!t||!t.closest||!t.closest('.main-content'))return;
        appbar.classList.toggle('condensed',(t.scrollTop||0)>12);
      },true);
      // 탭 전환 시 새 탭은 스크롤 top=0이므로 압축 해제
      this.$watch('activeTab',()=>appbar.classList.remove('condensed'));
    },


    async _initApp(){
      // 프로필 열린 후 앱 데이터 로드
      await Promise.all([this.loadNurses(),this.loadRules(),this.loadRequirements(),this.loadShifts(),this.loadScoringRules(),this.loadSavedList(),this.loadPrevSavesList()]);
      this._checkPendingGenerate();
      this._restoreFullState()||this._restoreAutoSave();
      this._startAutoSave();
      this.initAutoDark();
      this.loadTemplates();
      this._initScoringSliders();
      this._checkPrevMonthCarryover();
      this.checkFirstRun();
      this.loadFairnessLedger();
      this.$nextTick(()=>{if(window.lucide)lucide.createIcons()});
    },

    setFontSize(size){this.fontSize=size;localStorage.setItem('fontSize',size);document.documentElement.style.fontSize=size+'px'},

    // #2 스케줄 인원 부족 체크
    isScheduleStaffShort(day, period){
      if(!this.schedule||!Object.keys(this.schedule).length)return false;
      const wd=['sun','mon','tue','wed','thu','fri','sat'][day.getDay()];
      const req=this.requirements[wd];if(!req)return false;
      const k=this.dayKey(day);
      const count=Object.values(this.schedule).filter(ns=>{
        const s=ns[k];if(!s)return false;
        const info=this.shiftMap.get(s);
        return info&&info.period===period;
      }).length;
      const extCount=Object.values(this.extendedSchedule||{}).filter(ns=>{
        const s=ns[k];if(!s)return false;
        const info=this.shiftMap.get(s);
        return info&&info.period===period;
      }).length;
      const total=Math.max(count,extCount);
      const needed=(req.D||0)+(req.DC||0);
      if(period==='day')return total<needed;
      if(period==='evening')return total<(req.E||0)+(req.EC||0);
      if(period==='night')return total<(req.N||0)+(req.NC||0);
      return false;
    },

    // #3 이전달 스케줄 자동 감지
    async _checkPrevMonthCarryover(){
      if(Object.keys(this.prevSchedule).length>0)return; // 이미 사전입력 있으면 스킵
      try{
        const pm=this.month===1?12:this.month-1;
        const py=this.month===1?this.year-1:this.year;
        const res=await this.api('GET','/api/schedules');
        const has=res.some(s=>s.year===py&&s.month===pm);
        if(has)this.showPrevHint=true;
      }catch(e){}
    },

    // #7 분석 경고 수집
    collectAnalysisWarnings(){
      if(!this.analysisResult)return;
      const w=[];
      const days=this.analysisResult.days||[];
      for(const d of days){
        if(d.余裕<=0)w.push(`${d.date}: 인원 부족 (여유 ${d.余裕})`);
      }
      this.analysisWarnings=w.slice(0,5);
    },

    // #13 스케줄 자동 저장
    async _autoSaveSchedule(){
      if(!this.schedule||!Object.keys(this.schedule).length)return;
      try{
        const name=`자동저장 ${this.year}-${String(this.month).padStart(2,'0')}`;
        // 수동 저장(saveSchedule)과 동일한 스키마 — 이전 payload는 ScheduleSave
        // 필수 필드가 없어 항상 422로 무음 실패했다.
        await this.api('POST','/api/schedules',{year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,schedule:this.schedule,name,solver_log:this.solverLogs.map(l=>l.msg).join('\n'),prev_schedule:this.prevSchedule,nurse_scores:this.nurseScores,nurse_score_details:this.nurseScoreDetails,locked_cells:this.lockedCells,cell_notes:this.cellNotes,holidays:this.holidays,prev_day_reqs:this.prevDayReqs,prev_month_nights:this.prevMonthNights});
        this.toast('스케줄 자동 저장됨','info');
        this.loadSavedList();
      }catch(e){console.warn('자동저장 실패:',e)}
    },

    // #14 초기화 2단계 확인
    confirmReset(){
      const cnt=this.countPrevEntries();
      return confirm(`${this.year}년 ${this.month}월 사전입력을 초기화하시겠습니까?\n\n현재 ${cnt}건의 사전입력이 삭제됩니다.\n(해당 월의 모든 주기 포함)`);
    },

    // #4 사전입력 진행률
    get prevInputProgress(){
      if(!this.nurses.length)return 0;
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      const total=this.nurses.length*days.length;
      if(!total)return 0;
      let filled=0;
      for(const n of this.nurses){
        for(const d of days){
          if(this.prevSchedule[n.id]?.[this.dayKey(d)])filled++;
        }
      }
      return Math.round(filled/total*100);
    },

    async _checkPendingGenerate(){
      try{
        const res=await this.api('GET','/api/generate/result');
        if(res.status==='running'){
          this.generating=true;this.generateStartTime=Date.now();this.generateElapsed=0;
          this.generateTimer=setInterval(()=>{this.generateElapsed=Math.floor((Date.now()-this.generateStartTime)/1000)},1000);
          this.solverLogs=[];this._logSeq=0;
          this.solveProgress={gap_percent:null,nodes:0,has_solution:false,is_running:true};
          this.sseSource=new EventSource('/api/generate/stream');
          this.sseSource.onmessage=(e)=>{
            const data=JSON.parse(e.data);
            if(data.type==='log'){this.solverLogs.push({id:++this._logSeq,msg:data.msg});if(this.solverLogs.length>300)this.solverLogs=this.solverLogs.slice(-200);this.$nextTick(()=>{const el=document.getElementById('logPanel');if(el)el.scrollTop=el.scrollHeight})}
            else if(data.type==='progress')this.solveProgress=data;
            else if(data.type==='done'){this.sseSource.close();this.sseSource=null}
          };
          this.activeTab='schedule';this.statusMessage='이전 생성이 진행 중입니다. 완료될 때까지 대기합니다...';this.statusOk=true;
          this._recoverPoll=setInterval(async()=>{
            const pollRef=this._recoverPoll;
            try{const r=await this.api('GET','/api/generate/result');
              if(r.status==='done'&&r.result){clearInterval(pollRef);if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}if(this.sseSource){this.sseSource.close();this.sseSource=null}this.generating=false;this.generateFinalElapsed=this.generateElapsed;const result=r.result;this.statusOk=result.success;this.statusMessage=result.message;this.generationReport=result.generation_report||null;this.wishReport=result.wish_report||null;if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.relaxedCells=result.relaxed_cells||{};this.trackEdits();this._autoSaveSchedule();this.runAnalysis()}}
            }catch(e){}
          },2000);
        }else if(res.status==='done'&&res.result){
          const result=res.result;this.statusOk=result.success;this.statusMessage=result.message+'\n(이전 생성 결과 복원됨)';
          this.generationReport=result.generation_report||null;
          this.wishReport=result.wish_report||null;
          if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.relaxedCells=result.relaxed_cells||{};this.trackEdits();this.activeTab='schedule'}
        }
      }catch(e){}
    },

    // ── API ───────────────────────────────────────────────────
    async api(method,url,body,extraOpts={}){
      const opts={method,headers:{'Content-Type':'application/json'},...extraOpts};
      if(body!==undefined)opts.body=JSON.stringify(body);
      const res=await fetch(url,opts);if(!res.ok)throw new Error(await res.text());return res.json();
    },

    // ── Undo/Redo ────────────────────────────────────────────
    // _pushUndo / undo / redo 는 modules/undo-redo.js 로 이동.

    // ── 외부 모듈 합성 (modules/*.js — index.html에서 app.js 앞에 로드) ──
    ...(window.MiscFeaturesModule ? window.MiscFeaturesModule() : {}),
    ...(window.ScheduleFeaturesModule ? window.ScheduleFeaturesModule() : {}),
    ...(window.GridInteractionsModule ? window.GridInteractionsModule() : {}),
    ...(window.PreinputIoModule ? window.PreinputIoModule() : {}),
    ...(window.ViewHelpersModule ? window.ViewHelpersModule() : {}),
    ...(window.SolverModule ? window.SolverModule() : {}),
    ...(window.SettingsDefsModule ? window.SettingsDefsModule() : {}),
    ...(window.NurseManageModule ? window.NurseManageModule() : {}),
    ...(window.DevToolsModule ? window.DevToolsModule() : {}),
    ...(window.ProfilesModule ? window.ProfilesModule() : {}),
    ...(window.PasteImportModule ? window.PasteImportModule() : {}),
    ...(window.AssignModule ? window.AssignModule() : {}),
    // 동일 키가 위에 있으면 이쪽으로 덮어쓰여지므로, 모듈로 옮긴 메서드는
    // 반드시 위쪽 정의에서 제거되어야 함 (drag-select, undo-redo 모듈 참고).
    ...(window.UndoRedoModule ? window.UndoRedoModule() : {}),
    ...(window.DragSelectModule ? window.DragSelectModule() : {}),
    ...(window.AnalysisModule ? window.AnalysisModule() : {}),
  };
}
