function app() {
  return {
    // ── 상태 ──────────────────────────────────────────────────
    tabs: [
      {id:'settings', label:'설정'},
      {id:'preinput', label:'사전입력'},
      {id:'analysis', label:'분석'},
      {id:'schedule', label:'스케줄'},
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
      return this.nurses.map(nurse=>{
        const nid=nurse.id;
        const sc=this.schedule[nid]||{};
        let d=0,e=0,n=0,rest=0,leave=0,weekendWork=0;
        for(const day of days){
          const dk=this.dayKey(day);
          const val=sc[dk];if(!val)continue;
          if(dayCodes.includes(val))d++;
          else if(eveCodes.includes(val))e++;
          else if(nightCodes.includes(val))n++;
          else if(restCodes.includes(val))rest++;
          else if(leaveCodes.includes(val))leave++;
          if((day.getDay()===0||day.getDay()===6)&&[...dayCodes,...eveCodes,...nightCodes].includes(val))weekendWork++;
        }
        return{name:nurse.name,group:nurse.group,d,e,n,rest,leave,weekendWork,total:d+e+n,score:this.nurseScores[nid]??0};
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
      const fo=Math.round((first-ref)/ms);const so=fo-((fo%7+7)%7);
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
          else if((e.ctrlKey||e.metaKey)&&e.key==='z'&&this.activeTab==='preinput'&&!_isTyping){e.shiftKey?this.redo():this.undo();e.preventDefault()}
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
        await this.api('POST','/api/schedules',{year:this.year,month:this.month,data:{schedule:this.schedule,extended:this.extendedSchedule,scores:this.nurseScores,scoreDetails:this.nurseScoreDetails,relaxed:this.relaxedCells},name});
        this.toast('스케줄 자동 저장됨','info');
        this.loadSavedList();
      }catch(e){}
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
              if(r.status==='done'&&r.result){clearInterval(pollRef);if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}if(this.sseSource){this.sseSource.close();this.sseSource=null}this.generating=false;this.generateFinalElapsed=this.generateElapsed;const result=r.result;this.statusOk=result.success;this.statusMessage=result.message;if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.trackEdits();this._autoSaveSchedule();this.runAnalysis()}}
            }catch(e){}
          },2000);
        }else if(res.status==='done'&&res.result){
          const result=res.result;this.statusOk=result.success;this.statusMessage=result.message+'\n(이전 생성 결과 복원됨)';
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

    // ── 셀 편집 ──────────────────────────────────────────────
    openShiftEdit(nurse,day){this.shiftEdit={open:true,nurse,day,dateLabel:`${day.getMonth()+1}/${day.getDate()}`,mode:'schedule'}},
    openPrevEdit(nurse,day){this.shiftEdit={open:true,nurse,day,dateLabel:`${day.getMonth()+1}/${day.getDate()}`,mode:'prev'}},
    getPrevShift(nurseId,day){return this.prevSchedule[nurseId]?.[this.dayKey(day)]||''},
    _cycleDateKeys(){const keys=new Set();for(const d of this.scheduleDays){keys.add(this.dayKey(d))}return keys},
    clearPrevSchedule(){if(!this.confirmReset())return;const keys=this._cycleDateKeys();for(const nid of Object.keys(this.prevSchedule)){for(const k of Object.keys(this.prevSchedule[nid])){if(keys.has(k))delete this.prevSchedule[nid][k]}if(!Object.keys(this.prevSchedule[nid]).length)delete this.prevSchedule[nid]}const newDR={};for(const[k,v]of Object.entries(this.prevDayReqs)){if(!keys.has(k))newDR[k]=v}this.prevDayReqs=newDR;this.holidays=this.holidays.filter(h=>!keys.has(h))},
    clearPrevOtherMonths(){if(!confirm(`${this.year}년 ${this.month}월 주기 이외의 데이터를 정리합니다. 계속하시겠습니까?`))return;const keys=this._cycleDateKeys();for(const nid of Object.keys(this.prevSchedule)){for(const k of Object.keys(this.prevSchedule[nid])){if(!keys.has(k))delete this.prevSchedule[nid][k]}if(!Object.keys(this.prevSchedule[nid]).length)delete this.prevSchedule[nid]}const newDR={};for(const[k,v]of Object.entries(this.prevDayReqs)){if(keys.has(k))newDR[k]=v}this.prevDayReqs=newDR;this.holidays=this.holidays.filter(h=>keys.has(h))},
    countPrevEntries(){return Object.values(this.prevSchedule).reduce((s,v)=>s+Object.keys(v).length,0)},
    countNursePrev(nurseId){return Object.keys(this.prevSchedule[nurseId]||{}).length},

    // ── 일별 필요인원 오버라이드 ──────────────────────────────
    getDayWeekKey(day){return['sun','mon','tue','wed','thu','fri','sat'][day.getDay()]},
    getDefaultDayReq(day,type){return(this.requirements[this.getDayWeekKey(day)]||{})[type]??0},
    getPrevDayReq(day,type){const v=(this.prevDayReqs[this.dayKey(day)]||{})[type];return(v!==undefined&&v!==null)?v:null},
    setPrevDayReq(day,type,val){
      const k=this.dayKey(day);const num=parseInt(val);
      if(!this.prevDayReqs[k])this.prevDayReqs[k]={};
      const defaultVal=this.getDefaultDayReq(day,type);
      // 빈값 또는 기본값과 같으면 override 제거
      if(isNaN(num)||val===''||val===null||num===defaultVal){
        delete this.prevDayReqs[k][type];
        if(Object.keys(this.prevDayReqs[k]).length===0)delete this.prevDayReqs[k];
      }else{
        this.prevDayReqs[k][type]=num;
      }
    },

    // ── 셀 편집 적용 ─────────────────────────────────────────
    applyShiftEdit(shift){
      const nid=this.shiftEdit.nurse.id;const k=this.dayKey(this.shiftEdit.day);
      if(this.shiftEdit.mode==='prev'){
        if(shift==='__CLEAR__'){if(this.prevSchedule[nid])delete this.prevSchedule[nid][k];this.shiftEdit.open=false}
        else if(shift==='주'){this.shiftEdit.open=false;this.juhuOptionModal={open:true,nurse:this.shiftEdit.nurse,day:this.shiftEdit.day}}
        else{if(!this.prevSchedule[nid])this.prevSchedule[nid]={};this.prevSchedule[nid][k]=shift;this.shiftEdit.open=false}
      }else{if(!this.schedule[nid])this.schedule[nid]={};this.schedule[nid][k]=shift;this.shiftEdit.open=false;this.checkScheduleViolations()}
    },

    // ── 법정공휴일 ───────────────────────────────────────────
    isHoliday(day){return this.holidays.includes(this.dayKey(day))},
    markHoliday(day){
      const k=this.dayKey(day);const dn=['일','월','화','수','목','금','토'];
      const label=`${day.getMonth()+1}/${day.getDate()}(${dn[day.getDay()]})`;
      if(this.isHoliday(day)){if(!confirm(`${label} 법정공휴일 지정을 해제합니다. 계속하시겠습니까?`))return;this.holidays=this.holidays.filter(h=>h!==k)}
      else{if(!confirm(`${label}을(를) 법정공휴일로 지정합니다.\n이 날에 각 간호사에게 개별적으로 '법'을 배정할 수 있습니다. 계속하시겠습니까?`))return;this.holidays.push(k)}
    },

    // ── 주휴 자동배분 ────────────────────────────────────────
    autoFillJuhu(nurse,baseDay){
      const nid=nurse.id;const dayNames=['일','월','화','수','목','금','토'];
      const baseWi=Math.floor(this._daysSinceRef(baseDay)/7);
      const basePeriod=Math.floor(baseWi/4);const W=baseDay.getDay();
      const seen=new Set();const toFill=[];
      for(const d of this.scheduleDays){const wi=Math.floor(this._daysSinceRef(d)/7);if(seen.has(wi))continue;seen.add(wi);
        const period=Math.floor(wi/4);const expectedW=((W-(period-basePeriod))%7+7)%7;
        const match=this.scheduleDays.find(day=>Math.floor(this._daysSinceRef(day)/7)===wi&&day.getDay()===expectedW);
        if(match)toFill.push({day:match,cycle:(wi%4)+1,dow:expectedW})}
      toFill.sort((a,b)=>a.day-b.day);
      const preview=toFill.map(f=>`${f.cycle}주기: ${f.day.getDate()}일(${dayNames[f.dow]})`).join('\n');
      if(!confirm(`${nurse.name}의 주휴를 아래와 같이 입력합니다:\n\n${preview}\n\n이미 입력된 날은 덮어씁니다. 계속하시겠습니까?`)){this.shiftEdit.open=false;return}
      this._pushUndo();
      if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
      for(const{day}of toFill)this.prevSchedule[nid][this.dayKey(day)]='주';
      this.shiftEdit.open=false;
    },
    // 고정 요일 자동배분 (로테이션 없이 매주 같은 요일)
    autoFillJuhuFixed(nurse,baseDay){
      const nid=nurse.id;const dayNames=['일','월','화','수','목','금','토'];
      const W=baseDay.getDay();
      const seen=new Set();const toFill=[];
      for(const d of this.scheduleDays){
        const wi=Math.floor(this._daysSinceRef(d)/7);
        if(seen.has(wi))continue;seen.add(wi);
        const match=this.scheduleDays.find(day=>Math.floor(this._daysSinceRef(day)/7)===wi&&day.getDay()===W);
        if(match)toFill.push({day:match,cycle:(wi%4)+1,dow:W});
      }
      toFill.sort((a,b)=>a.day-b.day);
      this._pushUndo();
      if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
      for(const{day}of toFill)this.prevSchedule[nid][this.dayKey(day)]='주';
    },
    // 이 셀만 주휴 배정
    fillJuhuSingle(nurse,day){
      const nid=nurse.id;const dk=this.dayKey(day);
      this._pushUndo();
      if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
      this.prevSchedule[nid][dk]='주';
    },

    // ── 다음 달 이월 ──────────────────────────────────────
    hasNextMonthData(){
      if(!this.schedule||!Object.keys(this.schedule).length)return false;
      const ny=this.month===12?this.year+1:this.year;const nm=this.month===12?1:this.month+1;
      const prefix=`${ny}-${String(nm).padStart(2,'0')}-`;
      return Object.values(this.schedule).some(days=>Object.keys(days).some(k=>k.startsWith(prefix)));
    },
    carryOverToNextMonth(){
      const ny=this.month===12?this.year+1:this.year;const nm=this.month===12?1:this.month+1;
      const prefix=`${ny}-${String(nm).padStart(2,'0')}-`;let count=0;
      for(const[nid,days]of Object.entries(this.schedule)){for(const[dateStr,shift]of Object.entries(days)){if(!dateStr.startsWith(prefix))continue;if(!this.prevSchedule[nid])this.prevSchedule[nid]={};this.prevSchedule[nid][dateStr]=shift;count++}}
      if(count===0){this.toast('다음 달로 넘길 데이터가 없습니다','info');return}
      this.year=ny;this.month=nm;this.activeTab='preinput';
      this.toast(`${ny}년 ${nm}월 사전입력에 ${count}건 추가`,'info');
    },

    // ── 저장/불러오기 ────────────────────────────────────────
    async saveSchedule(){
      const name=prompt('저장 이름을 입력하세요 (선택)',`${this.year}년 ${this.month}월`);if(name===null)return;
      await this.api('POST','/api/schedules',{year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,schedule:this.schedule,name:name||null,solver_log:this.solverLogs.map(l=>l.msg).join('\n'),prev_schedule:this.prevSchedule,nurse_scores:this.nurseScores,nurse_score_details:this.nurseScoreDetails,locked_cells:this.lockedCells,cell_notes:this.cellNotes,holidays:this.holidays,prev_day_reqs:this.prevDayReqs,prev_month_nights:this.prevMonthNights});
      await this.loadSavedList();this.toast('저장되었습니다','info');
    },
    async loadSavedList(){this.savedSchedules=await this.api('GET','/api/schedules')},
    async loadSaved(id){const data=await this.api('GET',`/api/schedules/${id}`);this.year=data.data.year||data.year;this.month=data.data.month||data.month;this.nurses=data.data.nurses||[];this.requirements=data.data.requirements||this.requirements;this.rules=data.data.rules||this.rules;this.schedule=data.data.schedule||{};this.prevSchedule=data.data.prev_schedule||{};this.nurseScores=data.data.nurse_scores||{};this.nurseScoreDetails=data.data.nurse_score_details||{};this.lockedCells=data.data.locked_cells||{};this.cellNotes=data.data.cell_notes||{};this.holidays=data.data.holidays||this.holidays;this.prevDayReqs=data.data.prev_day_reqs||{};this.prevMonthNights=data.data.prev_month_nights||{};const log=data.data.solver_log||'';if(log){this.solverLogs=log.split('\n').map((m,i)=>({id:i+1,msg:m}))}this.activeTab='schedule'},
    async deleteSaved(id){if(!confirm('삭제하시겠습니까?'))return;await this.api('DELETE',`/api/schedules/${id}`);await this.loadSavedList()},

    // ── 사전입력 저장 ────────────────────────────────────────
    async loadPrevSavesList(){this.prevSaves=await this.api('GET','/api/prev_schedules')},
    async savePrevToServer(){
      const name=this.prevSaveName.trim()||`${this.year}년 ${this.month}월 사전입력`;
      if(!Object.keys(this.prevSchedule).some(k=>Object.keys(this.prevSchedule[k]).length>0)){this.toast('저장할 사전입력 데이터가 없습니다','info');return}
      await this.api('POST','/api/prev_schedules',{year:this.year,month:this.month,name,data:{schedule:this.prevSchedule,day_reqs:this.prevDayReqs,holidays:this.holidays,prev_month_nights:this.prevMonthNights,locked_cells:this.lockedCells,cell_notes:this.cellNotes}});
      this.prevSaveName='';await this.loadPrevSavesList();
    },
    async loadPrevFromServer(id){
      const result=await this.api('GET',`/api/prev_schedules/${id}`);this.year=result.year;this.month=result.month;
      if(result.data&&result.data.schedule!==undefined){
        this.prevSchedule=result.data.schedule;
        this.prevDayReqs=result.data.day_reqs||{};
        this.holidays=result.data.holidays||[];
        this.prevMonthNights=result.data.prev_month_nights||{};
        this.lockedCells=result.data.locked_cells||{};
        this.cellNotes=result.data.cell_notes||{};
      } else {
        this.prevSchedule=result.data;this.prevDayReqs={};this.holidays=[];this.prevMonthNights={};
        this.lockedCells={};this.cellNotes={};
      }
      this.prevSavePanel=false;
    },
    async deletePrevSave(id){if(!confirm('삭제하시겠습니까?'))return;await this.api('DELETE',`/api/prev_schedules/${id}`);await this.loadPrevSavesList()},

    // ── 트레이니 근무 목록 ───────────────────────────────────
    isTraineeInTraining(nurse,day){
      if(!nurse?.is_trainee)return false;
      if(!nurse.training_end_date)return true; // 종료일 미설정 = 계속 트레이닝
      const end=new Date(nurse.training_end_date);
      return day<=end;
    },
    getEditShifts(){
      const nurse=this.shiftEdit.nurse;
      const day=this.shiftEdit.day;
      if(this.shiftEdit.mode==='prev'&&nurse&&this.isTraineeInTraining(nurse,day)){
        return this.traineeShifts;
      }
      if(this.shiftEdit.mode==='prev_multi')return this.prevShifts;
      if(this.shiftEdit.mode==='prev')return this.prevShifts;
      return this.allShifts;
    },

    // ── Undo/Redo ────────────────────────────────────────────
    // _pushUndo / undo / redo 는 modules/undo-redo.js 로 이동.

    // ── Auto-save ──────────────────────────────────────────
    _startAutoSave(){
      if(this._autoSaveTimer)return;
      this._autoSaveTimer=setInterval(()=>{
        try{localStorage.setItem(this._autoSaveKey,JSON.stringify({y:this.year,m:this.month,ps:this.prevSchedule,dr:this.prevDayReqs,hd:this.holidays,lk:this.lockedCells,nt:this.cellNotes,t:Date.now()}))}catch(e){}
      },30000);
    },
    _restoreAutoSave(){
      try{
        const raw=localStorage.getItem(this._autoSaveKey);
        if(!raw)return false;
        const d=JSON.parse(raw);
        if(Date.now()-d.t>86400000)return false; // 24시간 초과 무시
        if(Object.keys(this.prevSchedule).some(k=>Object.keys(this.prevSchedule[k]).length>0))return false; // 이미 데이터 있으면 무시
        this.year=d.y;this.month=d.m;this.prevSchedule=d.ps;this.prevDayReqs=d.dr||{};this.holidays=d.hd||[];
        this.lockedCells=d.lk||{};this.cellNotes=d.nt||{};
        return true;
      }catch(e){return false}
    },

    // ── 실시간 제약 위반 경고 ──────────────────────────────
    _checkViolations(){
      const v=[];
      const days=this.scheduleDays;
      const dayNames=['일','월','화','수','목','금','토'];
      const eveningCodes=this.shifts.filter(s=>s.period==='evening').map(s=>s.code);
      const middleCodes=this.shifts.filter(s=>s.period==='middle').map(s=>s.code);
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const dayCodes=this.shifts.filter(s=>s.period==='day').map(s=>s.code);
      const day1Codes=this.shifts.filter(s=>s.period==='day1').map(s=>s.code);
      const allDayCodes=[...dayCodes,...day1Codes];

      // 금지 전환 목록: [from코드들, to코드들, 라벨]
      const forbidden=[
        [eveningCodes, dayCodes,    'E→D'],
        [eveningCodes, day1Codes,   'E→D1'],
        [eveningCodes, middleCodes, 'E→중'],
        [nightCodes,   eveningCodes,'N→E'],
        [nightCodes,   dayCodes,    'N→D'],
        [nightCodes,   day1Codes,   'N→D1'],
        [nightCodes,   middleCodes, 'N→중'],
        [middleCodes,  dayCodes,    '중→D'],
        [middleCodes,  day1Codes,   '중→D1'],
      ];

      for(const nurse of this.nurses){
        const nid=nurse.id;
        for(let i=0;i<days.length-1;i++){
          const dk1=this.dayKey(days[i]);
          const dk2=this.dayKey(days[i+1]);
          const s1=(this.prevSchedule[nid]||{})[dk1];
          const s2=(this.prevSchedule[nid]||{})[dk2];
          if(!s1||!s2)continue;

          const d1=days[i].getDate(),d2=days[i+1].getDate();
          const dn1=dayNames[days[i].getDay()],dn2=dayNames[days[i+1].getDay()];

          for(const[fromCodes,toCodes,label]of forbidden){
            if(fromCodes.includes(s1)&&toCodes.includes(s2))
              v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (${label} 금지)`});
          }
        }
      }
      this.prevViolations=v;
      this._violationSet=new Set(v.map(x=>`${x.nid}|${x.dk}`));
    },
    hasViolation(nurseId,day){
      return this._violationSet?.has(`${nurseId}|${this.dayKey(day)}`)||false;
    },

    // ── 드래그 다중 선택 ───────────────────────────────────
    // onCellMouseDown/Over/Up, isDragSelected, applyMultiShiftEdit 는
    // modules/drag-select.js 로 이동.

    // ── 키보드 네비게이션 ──────────────────────────────────
    onGridKeyDown(event){
      if(!this._focusedCell)return;
      const{nIdx,dIdx}=this._focusedCell;
      const days=this.scheduleDays;
      let newN=nIdx,newD=dIdx;

      if(event.key==='ArrowRight'){newD=Math.min(days.length-1,dIdx+1);event.preventDefault()}
      else if(event.key==='ArrowLeft'){newD=Math.max(0,dIdx-1);event.preventDefault()}
      else if(event.key==='ArrowDown'){newN=Math.min(this.nurses.length-1,nIdx+1);event.preventDefault()}
      else if(event.key==='ArrowUp'){newN=Math.max(0,nIdx-1);event.preventDefault()}
      else if(event.key==='Delete'||event.key==='Backspace'){
        const nurse=this.nurses[nIdx];const dk=this.dayKey(days[dIdx]);
        if(nurse&&this.prevSchedule[nurse.id]?.[dk]){this._pushUndo();delete this.prevSchedule[nurse.id][dk];this._checkViolations()}
        event.preventDefault();return;
      }
      else if(event.key==='z'&&(event.ctrlKey||event.metaKey)){event.shiftKey?this.redo():this.undo();event.preventDefault();return}
      else{
        // 근무코드 직접 입력
        const key=event.key.toUpperCase();
        const shiftMap={'D':'D','E':'E','N':'N','V':'V','O':'OF','W':'주'};
        const hangulMap={'ㅈ':'주','ㅂ':'병','ㅅ':'생','ㅌ':'특','ㄱ':'공','ㅂ':'법'};
        let code=shiftMap[key]||hangulMap[event.key];
        if(!code){
          const match=this.shifts.find(s=>s.code.toUpperCase()===key);
          if(match)code=match.code;
        }
        if(code){
          const nurse=this.nurses[nIdx];const dk=this.dayKey(days[dIdx]);
          if(nurse){this._pushUndo();if(!this.prevSchedule[nurse.id])this.prevSchedule[nurse.id]={};this.prevSchedule[nurse.id][dk]=code;this._checkViolations()}
          event.preventDefault();return;
        }
        return;
      }
      this._focusedCell={nIdx:newN,dIdx:newD};
    },
    focusCell(nIdx,dIdx){this._focusedCell={nIdx,dIdx}},
    isFocused(nIdx,dIdx){return this._focusedCell?.nIdx===nIdx&&this._focusedCell?.dIdx===dIdx},

    // ── 셀 잠금 ────────────────────────────────────────────
    toggleLock(nurseId,day){
      const dk=this.dayKey(day);
      if(!this.lockedCells[nurseId])this.lockedCells[nurseId]={};
      if(this.lockedCells[nurseId][dk])delete this.lockedCells[nurseId][dk];
      else this.lockedCells[nurseId][dk]=true;
      if(Object.keys(this.lockedCells[nurseId]).length===0)delete this.lockedCells[nurseId];
    },
    isLocked(nurseId,day){return !!(this.lockedCells[nurseId]?.[this.dayKey(day)])},

    // ── 간호사 메모 ────────────────────────────────────────
    openNote(nurseId,day){
      const dk=this.dayKey(day);
      this.noteEdit={
        open:true,nurseId,dk,
        text:(this.cellNotes[nurseId]?.[dk])||'',
        locked:!!(this.lockedCells[nurseId]?.[dk]),
      };
    },
    saveNote(){
      const{nurseId,dk,text,locked}=this.noteEdit;
      if(!this.cellNotes[nurseId])this.cellNotes[nurseId]={};
      if(text.trim())this.cellNotes[nurseId][dk]=text.trim();
      else{delete this.cellNotes[nurseId][dk];if(!Object.keys(this.cellNotes[nurseId]).length)delete this.cellNotes[nurseId]}
      // 잠금 상태 반영 (완화 시에도 고정)
      if(locked){
        if(!this.lockedCells[nurseId])this.lockedCells[nurseId]={};
        this.lockedCells[nurseId][dk]=true;
      }else if(this.lockedCells[nurseId]){
        delete this.lockedCells[nurseId][dk];
        if(!Object.keys(this.lockedCells[nurseId]).length)delete this.lockedCells[nurseId];
      }
      this.noteEdit.open=false;
    },
    hasNote(nurseId,day){return !!(this.cellNotes[nurseId]?.[this.dayKey(day)])},
    getNote(nurseId,day){return this.cellNotes[nurseId]?.[this.dayKey(day)]||''},

    // ── 행 복사 ────────────────────────────────────────────
    setCopySource(nurseId){this.copySource=nurseId},
    pasteRow(targetNurseId){
      if(!this.copySource||this.copySource===targetNurseId)return;
      this._pushUndo();
      const src=this.prevSchedule[this.copySource]||{};
      const keys=this._cycleDateKeys();
      if(!this.prevSchedule[targetNurseId])this.prevSchedule[targetNurseId]={};
      for(const k of keys){
        if(src[k])this.prevSchedule[targetNurseId][k]=src[k];
        else delete this.prevSchedule[targetNurseId][k];
      }
      this.copySource=null;
      this._checkViolations();
    },

    // ── 희망근무 표시 ──────────────────────────────────────
    hasWish(nurseId,day){
      const nurse=this.nurses.find(n=>n.id===nurseId);
      if(!nurse||!nurse.wishes)return false;
      const dk=this.dayKey(day);
      return !!(nurse.wishes[dk]);
    },
    getWish(nurseId,day){
      const nurse=this.nurses.find(n=>n.id===nurseId);
      if(!nurse||!nurse.wishes)return '';
      return nurse.wishes[this.dayKey(day)]||'';
    },

    // ── 프리셋 패턴 ────────────────────────────────────────
    applyPreset(presetIdx,nurseId){this.presets[presetIdx].apply(nurseId);this.presetPanel=false},

    // ── 야간 카운터 ────────────────────────────────────────
    countPrevNights(nurseId){
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const ps=this.prevSchedule[nurseId]||{};
      return Object.values(ps).filter(v=>nightCodes.includes(v)).length;
    },

    // ── 사전입력 편집 래핑 (undo 지원) ────────────────────
    applyShiftEditWithUndo(shift){
      this._pushUndo();
      if(this.shiftEdit.mode==='prev_multi'){
        this.applyMultiShiftEdit(shift);return;
      }
      this.applyShiftEdit(shift);
      this._checkViolations();
    },

    // ── 사전입력 배정 카운트 ──────────────────────────────────
    getPrevAssignedCount(day, type){
      // type: 'D','E','N','중' 등 — 해당 코드에 배정된 사전입력 간호사 수
      const dk=this.dayKey(day);
      const periodShifts={
        D: this.shifts.filter(s=>s.period==='day').map(s=>s.code),
        E: this.shifts.filter(s=>s.period==='evening').map(s=>s.code),
        N: this.shifts.filter(s=>s.period==='night').map(s=>s.code),
      };
      // D/E/N 그룹에 없으면 개별 코드로 매칭
      const codes=periodShifts[type]||[type];
      let count=0;
      for(const nurse of this.nurses){
        const val=(this.prevSchedule[nurse.id]||{})[dk];
        if(val&&codes.includes(val))count++;
      }
      return count;
    },
    getPrevRemaining(day, type){
      const assigned=this.getPrevAssignedCount(day,type);
      const req=this.getPrevDayReq(day,type);
      const needed=req!==null?req:this.getDefaultDayReq(day,type);
      return Math.max(0,needed-assigned);
    },

    // ═══ 1. 엑셀 내보내기 ═══════════════════════════════════
    exportToCSV(){
      if(!this.schedule||!Object.keys(this.schedule).length)return;
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      const dayNames=['일','월','화','수','목','금','토'];
      let csv='\uFEFF'; // BOM for Korean
      // 헤더
      csv+='이름,그룹,'+days.map(d=>`${d.getMonth()+1}/${d.getDate()}(${dayNames[d.getDay()]})`).join(',')+',D,E,N,휴무\n';
      // 데이터
      for(const nurse of this.nurses){
        const shifts=days.map(d=>{
          const s=this.schedule[nurse.id]?.[this.dayKey(d)]||'';
          return this.hideCharge?s.replace('DC','D').replace('EC','E').replace('NC','N'):s;
        });
        const dCnt=this.countShifts(nurse.id,['DC','D']);
        const eCnt=this.countShifts(nurse.id,['EC','E']);
        const nCnt=this.countShifts(nurse.id,['NC','N']);
        const restCnt=this.countShifts(nurse.id,['OF','주']);
        csv+=`${nurse.name},${nurse.group},${shifts.join(',')},${dCnt},${eCnt},${nCnt},${restCnt}\n`;
      }
      const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');
      a.href=url;a.download=`근무표_${this.year}년${this.month}월.csv`;
      a.click();URL.revokeObjectURL(url);
    },

    // ═══ 2. 인쇄 ═══════════════════════════════════════════
    printSchedule(){window.print()},

    // ═══ 3. 스케줄 비교 ═══════════════════════════════════
    compareMode:false, compareSchedule:null, compareName:'',
    async loadCompare(id){
      const data=await this.api('GET',`/api/schedules/${id}`);
      this.compareSchedule=data.data.schedule||{};
      this.compareName=data.data.name||`${data.data.year||data.year}년 ${data.data.month||data.month}월`;
      this.compareMode=true;
    },
    closeCompare(){this.compareMode=false;this.compareSchedule=null;this.compareName=''},
    getCompareDiff(nurseId,day){
      if(!this.compareSchedule)return null;
      const dk=this.dayKey(day);
      const cur=this.schedule[nurseId]?.[dk]||'';
      const prev=this.compareSchedule[nurseId]?.[dk]||'';
      if(cur===prev)return null;
      return{from:prev,to:cur};
    },

    // ═══ 4. 수동 편집 추적 ═══════════════════════════════
    _originalSchedule:null,
    trackEdits(){
      this._originalSchedule=JSON.parse(JSON.stringify(this.schedule));
      this.checkScheduleViolations();
    },
    isManuallyEdited(nurseId,day){
      if(!this._originalSchedule)return false;
      const dk=this.dayKey(day);
      const orig=this._originalSchedule[nurseId]?.[dk]||'';
      const cur=this.schedule[nurseId]?.[dk]||'';
      return orig!==cur;
    },
    getManualEditCount(){
      if(!this._originalSchedule)return 0;
      let count=0;
      for(const nid of Object.keys(this.schedule)){
        for(const[dk,val]of Object.entries(this.schedule[nid]||{})){
          if((this._originalSchedule[nid]?.[dk]||'')!==val)count++;
        }
      }
      return count;
    },

    // ═══ 5. 간호사별 월간 요약 ═══════════════════════════
    showNurseSummary:false,

    // ═══ 6. 이전달 스케줄 자동 연동 ══════════════════════
    async loadPrevMonthSchedule(){
      const py=this.month===1?this.year-1:this.year;
      const pm=this.month===1?12:this.month-1;
      const list=await this.api('GET','/api/schedules');
      const prev=list.find(s=>s.year===py&&s.month===pm);
      if(!prev){this.toast(`${py}년 ${pm}월 저장된 스케줄이 없습니다`,'error');return}
      const data=await this.api('GET',`/api/schedules/${prev.id}`);
      const schedule=data.data.schedule||{};
      // 마지막 주기의 데이터를 현재 달 사전입력에 이월
      let count=0;
      const monthPrefix=`${this.year}-${String(this.month).padStart(2,'0')}-`;
      for(const[nid,days]of Object.entries(schedule)){
        for(const[dk,shift]of Object.entries(days)){
          // 이전달 스케줄에서 현재 달에 해당하는 overflow 날짜만
          if(!dk.startsWith(monthPrefix))continue;
          if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
          this.prevSchedule[nid][dk]=shift;count++;
        }
      }
      if(count>0)this.toast(`${py}년 ${pm}월에서 ${count}건 이월 완료`,'info');
      else this.toast('이월할 데이터가 없습니다','info');
    },

    // ═══ 7. 간호사 희망근무 입력 ══════════════════════════
    wishEditMode:false,
    wishEditNurse:null,
    openWishEdit(nurse){this.wishEditNurse=nurse;this.wishEditMode=true},
    closeWishEdit(){this.wishEditMode=false;this.wishEditNurse=null},
    setWish(nurseId,day,shift){
      const nurse=this.nurses.find(n=>n.id===nurseId);
      if(!nurse)return;
      if(!nurse.wishes)nurse.wishes={};
      const dk=this.dayKey(day);
      if(shift)nurse.wishes[dk]=shift;
      else delete nurse.wishes[dk];
    },
    clearWish(nurseId,day){
      const nurse=this.nurses.find(n=>n.id===nurseId);
      if(!nurse||!nurse.wishes)return;
      delete nurse.wishes[this.dayKey(day)];
    },

    // ═══ 9. 다중 솔버 비교 ═══════════════════════════════
    multiSolveResults:[],
    async generateMultiple(count=2){
      this.multiSolveResults=[];
      for(let i=0;i<count;i++){
        const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:Math.max(0.02,this.mipGap+i*0.02),time_limit:Math.min(this.generateTimeout*60,120),allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,unlimited_v:this.unlimitedV,solver:this.solver};
        try{
          const result=await this.api('POST','/api/generate',payload);
          if(result.success)this.multiSolveResults.push({idx:i+1,schedule:result.schedule,scores:result.nurse_scores||{},gap:result.mip_gap_percent,msg:result.message});
        }catch(e){}
      }
      if(this.multiSolveResults.length>0)this.toast(`${this.multiSolveResults.length}개의 해 생성 완료`,'info');
      else this.toast('해를 생성하지 못했습니다','error');
    },
    selectMultiResult(idx){
      const r=this.multiSolveResults[idx];
      if(!r)return;
      this.schedule=r.schedule;this.nurseScores=r.scores;this.mipGapPercent=r.gap;
      this.statusMessage=r.msg;this.statusOk=true;
      this.trackEdits();
    },

    // ═══ 10. 템플릿 저장/불러오기 ════════════════════════
    templates:[],
    async loadTemplates(){
      try{const raw=localStorage.getItem('ns_templates');this.templates=raw?JSON.parse(raw):[]}catch(e){this.templates=[]}
    },
    saveTemplate(){
      const name=prompt('템플릿 이름을 입력하세요','기본 템플릿');if(!name)return;
      this.templates.push({name,nurses:JSON.parse(JSON.stringify(this.nurses)),requirements:JSON.parse(JSON.stringify(this.requirements)),rules:JSON.parse(JSON.stringify(this.rules)),shifts:JSON.parse(JSON.stringify(this.shifts)),created:new Date().toISOString().slice(0,16)});
      localStorage.setItem('ns_templates',JSON.stringify(this.templates));
    },
    loadTemplate(idx){
      const t=this.templates[idx];if(!t)return;
      if(!confirm(`'${t.name}' 템플릿을 불러오시겠습니까?\n현재 간호사/규칙/인원 설정이 교체됩니다.`))return;
      this.nurses=t.nurses;this.requirements=t.requirements;this.rules=t.rules;
      if(t.shifts)this.shifts=t.shifts;
    },
    deleteTemplate(idx){this.templates.splice(idx,1);localStorage.setItem('ns_templates',JSON.stringify(this.templates))},

    // ═══ 간호사 CSV 템플릿 다운로드/업로드 ═══════════════════
    async downloadNurseTemplate(){
      try{
        const res=await fetch('/api/nurses/template');
        if(!res.ok)throw new Error('템플릿 다운로드 실패');
        const blob=await res.blob();
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;a.download='nurses_template.csv';
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);URL.revokeObjectURL(url);
        this.toast('템플릿 다운로드 완료','info');
      }catch(e){this.toast(e.message||'다운로드 실패','error')}
    },

    async exportNursesToCSV(){
      if(!this.nurses.length){this.toast('내보낼 간호사가 없습니다','warn');return}
      try{
        const res=await fetch('/api/nurses/export');
        if(!res.ok)throw new Error('내보내기 실패');
        const blob=await res.blob();
        const url=URL.createObjectURL(blob);
        const ymd=new Date().toISOString().slice(0,10);
        const a=document.createElement('a');
        a.href=url;a.download=`nurses_${ymd}.csv`;
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);URL.revokeObjectURL(url);
        this.toast(`${this.nurses.length}명 내보내기 완료`,'info');
      }catch(e){this.toast(e.message||'내보내기 실패','error')}
    },

    csvImportResult:{open:false,imported:0,errors:[],filename:''},
    csvImportPreview:{
      open:false, loading:false, filename:'', fileB64:'',
      replaceAll:false, parsed_count:0,
      will_add:[], will_update:[], will_delete:[],
      unchanged_count:0, errors:[],
    },
    csvDragOver:false,

    _arrayBufferToBase64(buf){
      const bytes=new Uint8Array(buf);
      let binary='';
      const chunk=0x8000;
      for(let i=0;i<bytes.length;i+=chunk){
        binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunk));
      }
      return btoa(binary);
    },

    async importNursesFromCSV(event){
      const file=event.target?.files?.[0];
      if(!file){return}
      event.target.value='';
      await this._loadCsvFile(file);
    },

    async onCsvDrop(event){
      this.csvDragOver=false;
      const file=event.dataTransfer?.files?.[0];
      if(!file){return}
      if(!/\.(csv|txt)$/i.test(file.name)){
        this.toast('CSV 또는 TXT 파일만 가능합니다','warn');
        return;
      }
      await this._loadCsvFile(file);
    },

    async _loadCsvFile(file){
      const loadingId=this.toast(`'${file.name}' 분석 중...`,'loading');
      try{
        const buf=await file.arrayBuffer();
        const b64=this._arrayBufferToBase64(buf);
        this.csvImportPreview={
          open:true, loading:true, filename:file.name, fileB64:b64,
          replaceAll:false, parsed_count:0,
          will_add:[], will_update:[], will_delete:[],
          unchanged_count:0, errors:[],
        };
        await this._refreshImportPreview();
        this.dismissToast(loadingId);
      }catch(e){
        this.dismissToast(loadingId);
        this.toast(e.message||'파일 읽기 실패','error');
      }
    },

    async _refreshImportPreview(){
      if(!this.csvImportPreview.fileB64)return;
      this.csvImportPreview.loading=true;
      try{
        const res=await this.api('POST','/api/nurses/import/preview',{
          csv_b64:this.csvImportPreview.fileB64,
          replace_all:this.csvImportPreview.replaceAll,
        });
        if(res.ok){
          Object.assign(this.csvImportPreview,{
            loading:false,
            parsed_count:res.parsed_count,
            will_add:res.will_add,
            will_update:res.will_update,
            will_delete:res.will_delete,
            unchanged_count:res.unchanged_count,
            errors:res.errors,
          });
        }
      }catch(e){
        this.csvImportPreview.loading=false;
        this.toast(e.message||'미리보기 실패','error');
      }
    },

    async applyCsvImport(){
      const p=this.csvImportPreview;
      if(!p.fileB64)return;
      if(p.parsed_count===0){
        this.toast('가져올 행이 없습니다','warn');return;
      }
      const loadingId=this.toast('적용 중...','loading');
      try{
        const res=await this.api('POST','/api/nurses/import',{
          csv_b64:p.fileB64,
          replace_all:p.replaceAll,
        });
        this.dismissToast(loadingId);
        if(res.ok){
          await this.loadNurses();
          this.csvImportPreview.open=false;
          const summary=`+${p.will_add.length}명 추가, ${p.will_update.length}명 수정`+
            (p.replaceAll&&p.will_delete.length?`, ${p.will_delete.length}명 삭제`:'');
          this.toast(summary,'info');
        }
      }catch(e){
        this.dismissToast(loadingId);
        this.toast(e.message||'적용 실패','error');
      }
    },

    closeCsvImport(){
      this.csvImportPreview.open=false;
      this.csvImportPreview.fileB64='';
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

    // ── 외부 모듈 합성 (modules/*.js — index.html에서 app.js 앞에 로드) ──
    ...(window.ViewHelpersModule ? window.ViewHelpersModule() : {}),
    ...(window.SolverModule ? window.SolverModule() : {}),
    ...(window.SettingsDefsModule ? window.SettingsDefsModule() : {}),
    ...(window.NurseManageModule ? window.NurseManageModule() : {}),
    ...(window.DevToolsModule ? window.DevToolsModule() : {}),
    ...(window.ProfilesModule ? window.ProfilesModule() : {}),
    ...(window.PasteImportModule ? window.PasteImportModule() : {}),
    // 동일 키가 위에 있으면 이쪽으로 덮어쓰여지므로, 모듈로 옮긴 메서드는
    // 반드시 위쪽 정의에서 제거되어야 함 (drag-select, undo-redo 모듈 참고).
    ...(window.UndoRedoModule ? window.UndoRedoModule() : {}),
    ...(window.DragSelectModule ? window.DragSelectModule() : {}),
    ...(window.AnalysisModule ? window.AnalysisModule() : {}),
  };
}
