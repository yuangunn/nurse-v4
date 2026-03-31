function app() {
  return {
    // ── 상태 ──────────────────────────────────────────────────
    tabs: [
      {id:'settings', label:'설정'},
      {id:'preinput', label:'사전입력'},
      {id:'schedule', label:'스케줄'},
      {id:'saved',    label:'저장'},
      {id:'analysis', label:'분석'},
    ],
    activeTab: 'settings',
    fontSize: parseInt(localStorage.getItem('fontSize'))||20,
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
    },
    schedule:{}, extendedSchedule:{},
    generating:false, generateStartTime:null, generateElapsed:0, generateFinalElapsed:0,
    generateTimer:null, sseSource:null, solverLogs:[], showLogPanel:false,
    solveProgress:{gap_percent:null,nodes:0,has_solution:false,is_running:false},
    stopRequested:false, mipGap:0.02, generateTimeout:20, allowPreRelax:false, allowJuhuRelax:false, unlimitedV:false, relaxedCells:{},
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

    // ── UX 개선 ──
    scheduleGenOptions:true,        // #5 모바일 옵션 접기
    showPrevHint:false,             // #3 이전달 이월 힌트
    generatePhase:'',               // #12 진행단계 ('building'|'solving'|'extracting'|'done')
    analysisWarnings:[],            // #7 분석 경고 요약
    resetConfirmStep:0,             // #14 초기화 2단계

    // ── computed ──────────────────────────────────────────────
    get shiftMap(){const m=new Map();for(const s of this.shifts)m.set(s.code,s);return m},
    get allWorkShifts(){return this.shifts.filter(s=>['day','day1','evening','middle','night'].includes(s.period)).map(s=>s.code)},
    get allShifts(){return this.shifts.map(s=>s.code)},
    get prevShifts(){return this.shifts.filter(s=>!s.is_charge).map(s=>s.code)},
    get footerRows(){
      const d=this.shifts.filter(s=>s.period==='day').map(s=>s.code);
      const e=this.shifts.filter(s=>s.period==='evening').map(s=>s.code);
      const n=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const r=this.shifts.filter(s=>s.period==='rest').map(s=>s.code);
      return [{label:'낮',shifts:d,color:'text-blue-700'},{label:'저녁',shifts:e,color:'text-green-700'},{label:'야간',shifts:n,color:'text-amber-700'},{label:'휴무',shifts:r,color:'text-gray-600'}];
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
          if(this.activeTab==='preinput'&&this._focusedCell&&!this.shiftEdit.open&&!this.noteEdit.open&&!this.juhuOptionModal.open){this.onGridKeyDown(e)}
          else if((e.ctrlKey||e.metaKey)&&e.key==='z'&&this.activeTab==='preinput'){e.shiftKey?this.redo():this.undo();e.preventDefault()}
        });
      }
      window.addEventListener('beforeunload',()=>{this._saveFullState();this._closeCurrentProfile()});
      document.addEventListener('mouseup',()=>{if(this._isDragging)this.onCellMouseUp()});
      this.$nextTick(()=>{if(window.lucide)lucide.createIcons()});
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
      this._checkPrevMonthCarryover();  // #3
      this.$nextTick(()=>{if(window.lucide)lucide.createIcons()});
    },

    // ── 프로필 관리 ──
    async _loadProfiles(){
      try{
        const res=await this.api('GET','/api/profiles');
        this.profiles=res.profiles||[];
        this.hasMasterPassword=res.has_master_password||false;
        this.currentProfile=res.current_profile;
      }catch(e){this.profiles=[];this.hasMasterPassword=false}
    },

    async selectProfile(profile){
      this.profileError='';
      if(profile.has_password||this.hasMasterPassword){
        // 비밀번호 입력 필요 — 이미 입력된 상태에서 호출됨
        if(profile.has_password&&!this.profilePasswordInput){
          this.profileError='비밀번호를 입력해주세요.';return;
        }
      }
      const body={id:profile.id,password:this.profilePasswordInput||''};
      if(this.hasMasterPassword)body.master_password=this.profileMasterInput||'';

      try{
        const res=await this.api('POST','/api/profiles/open',body);
        if(!res.ok){
          if(res.need_master_password){this.profileError='마스터 비밀번호를 입력해주세요.';return}
          this.profileError=res.error||'프로필 열기 실패';return;
        }
        this.currentProfile=profile.id;
        this.profilePasswordInput='';
        this.profileMasterInput='';
        this.profileScreen=false;
        await this._initApp();
      }catch(e){this.profileError=e.message||'서버 오류'}
    },

    async _closeCurrentProfile(){
      if(!this.currentProfile)return;
      try{await this.api('POST','/api/profiles/close')}catch(e){}
    },

    profileSwitchModal:false,
    async switchProfile(){
      this.profilePasswordInput='';
      this.profileMasterInput='';
      this.profileError='';
      await this._loadProfiles();
      this.profileSwitchModal=true;
    },
    async switchToProfile(profile){
      this.profileError='';
      if(profile.has_password&&!this.profilePasswordInput){
        this.profileError='비밀번호를 입력해주세요.';return;
      }
      const body={id:profile.id,password:this.profilePasswordInput||''};
      if(this.hasMasterPassword)body.master_password=this.profileMasterInput||'';
      try{
        await this._closeCurrentProfile();
        const res=await this.api('POST','/api/profiles/open',body);
        if(!res.ok){this.profileError=res.error||'프로필 열기 실패';return}
        this.currentProfile=profile.id;
        this.profilePasswordInput='';
        this.profileMasterInput='';
        this.profileSwitchModal=false;
        this.nurses=[];this.schedule={};this.prevSchedule={};
        await this._initApp();
      }catch(e){this.profileError=e.message||'서버 오류'}
    },

    openProfileCreate(){
      this.profileCreateModal={open:true,id:'',name:'',password:'',passwordConfirm:''};
    },

    async createProfile(){
      const m=this.profileCreateModal;
      if(!m.id.trim()||!m.name.trim()){this._toast('ID와 이름을 입력해주세요.','error');return}
      if(m.password&&m.password!==m.passwordConfirm){this._toast('비밀번호가 일치하지 않습니다.','error');return}
      try{
        await this.api('POST','/api/profiles/create',{id:m.id.trim(),name:m.name.trim(),password:m.password});
        m.open=false;
        await this._loadProfiles();
        this._toast(`프로필 "${m.name}" 생성 완료`);
      }catch(e){this._toast(e.message||'생성 실패','error')}
    },

    async confirmDeleteProfile(profileId){
      const profile=this.profiles.find(p=>p.id===profileId);
      if(!profile)return;
      const name=profile.name;
      const input=prompt(`이 프로필과 모든 데이터가 영구 삭제됩니다.\n삭제하려면 "${name}"을(를) 입력하세요:`);
      if(input===null)return; // 취소
      if(input.trim()!==name){this._toast('프로필 이름이 일치하지 않습니다.','error');return}
      try{
        await this.api('DELETE',`/api/profiles/${profileId}`);
        await this._loadProfiles();
        this._toast('프로필 삭제 완료');
      }catch(e){this._toast(e.message||'삭제 실패','error')}
    },

    openChangePw(profileId){
      this.profileChangePwModal={open:true,id:profileId,oldPw:'',newPw:'',newPwConfirm:''};
    },

    async changeProfilePassword(){
      const m=this.profileChangePwModal;
      if(!m.newPw){this._toast('새 비밀번호를 입력해주세요.','error');return}
      if(m.newPw!==m.newPwConfirm){this._toast('새 비밀번호가 일치하지 않습니다.','error');return}
      try{
        await this.api('POST','/api/profiles/change-password',{id:m.id,old_password:m.oldPw,new_password:m.newPw});
        m.open=false;
        this._toast('비밀번호 변경 완료');
      }catch(e){this._toast(e.message||'변경 실패','error')}
    },

    // ── 개발자 모드 이스터에그 ──
    trackVersionClick(){
      const now=Date.now();
      this._versionClickTimestamps.push(now);
      this._versionClickTimestamps=this._versionClickTimestamps.filter(t=>now-t<5000);
      if(this._versionClickTimestamps.length>=5){
        if(this._devModeUnlocked){
          // 이미 활성화 → 해제
          this._devModeUnlocked=false;
          localStorage.removeItem('devMode');
          this._toast('개발자 권한이 해제되었습니다','info');
        }else{
          this._devModeUnlocked=true;
          localStorage.setItem('devMode','true');
          this._toast('개발자 모드가 활성화되었습니다!','info');
        }
        this._versionClickTimestamps=[];
      }
    },

    async loadDevDbInfo(){
      try{
        const res=await this.api('GET','/api/dev/info');
        this.devDbInfo=res;
      }catch(e){this.devDbInfo=null}
    },

    async devResetProfilePassword(profileId){
      const name=this.profiles.find(p=>p.id===profileId)?.name||profileId;
      if(!confirm(`"${name}" 프로필의 비밀번호를 초기화하시겠습니까?`))return;
      try{
        await this.api('POST','/api/profiles/change-password',{id:profileId,old_password:'',new_password:'',force_reset:true});
        this._toast(`${name} 비밀번호 초기화 완료`);
        await this._loadProfiles();
      }catch(e){this._toast(e.message||'초기화 실패','error')}
    },

    devClearLocalStorage(){
      if(!confirm('브라우저 로컬 데이터를 모두 삭제하시겠습니까?'))return;
      localStorage.clear();
      this._toast('localStorage 삭제 완료. 새로고침합니다.');
      setTimeout(()=>location.reload(),1000);
    },

    async devResetSeedData(){
      if(!confirm('현재 프로필의 간호사를 예시 데이터(18명)로 초기화하시겠습니까?\n기존 간호사 데이터가 삭제됩니다.'))return;
      try{
        await this.api('POST','/api/dev/reset-seed');
        await this.loadNurses();
        this._toast('예시 데이터 초기화 완료');
      }catch(e){this._toast(e.message||'초기화 실패','error')}
    },

    async devDownloadDb(){
      try{
        const res=await fetch('/api/dev/download-db');
        const blob=await res.blob();
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);
        a.download=`${this.currentProfile||'nurse'}_backup.db`;
        a.click();URL.revokeObjectURL(a.href);
        this._toast('DB 백업 다운로드 완료');
      }catch(e){this._toast('다운로드 실패','error')}
    },

    async setDevMasterPassword(){
      if(!this.devMasterPw){this._toast('비밀번호를 입력해주세요.','error');return}
      if(this.devMasterPw!==this.devMasterPwConfirm){this._toast('비밀번호가 일치하지 않습니다.','error');return}
      try{
        await this.api('POST','/api/profiles/master-password',{action:'set',password:this.devMasterPw});
        this.hasMasterPassword=true;
        this.devMasterPw='';this.devMasterPwConfirm='';
        this._toast('마스터 비밀번호 설정 완료');
      }catch(e){this._toast(e.message||'설정 실패','error')}
    },

    async removeDevMasterPassword(){
      const current=prompt('현재 마스터 비밀번호를 입력하세요:');
      if(!current)return;
      try{
        await this.api('POST','/api/profiles/master-password',{action:'remove',current_password:current});
        this.hasMasterPassword=false;
        this._toast('마스터 비밀번호 제거 완료');
      }catch(e){this._toast(e.message||'제거 실패','error')}
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
        this._toast('스케줄 자동 저장됨','info');
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
              if(r.status==='done'&&r.result){clearInterval(pollRef);if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}if(this.sseSource){this.sseSource.close();this.sseSource=null}this.generating=false;this.generateFinalElapsed=this.generateElapsed;const result=r.result;this.statusOk=result.success;this.statusMessage=result.message;if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.trackEdits();this._autoSaveSchedule()}}
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

    // ── 간호사 ────────────────────────────────────────────────
    async loadNurses(){this.nurses=await this.api('GET','/api/nurses')},
    _monthKey(){return `${this.year}-${String(this.month).padStart(2,'0')}`},
    isNightThisMonth(nurse){const mk=this._monthKey();const nm=nurse.night_months||{};return Object.keys(nm).length>0?!!nm[mk]:nurse.is_night_shift},
    toggleNightMonthModal(m,checked){const mk=`${this.year}-${String(m).padStart(2,'0')}`;if(!this.nurseModal.data.night_months)this.nurseModal.data.night_months={};if(checked)this.nurseModal.data.night_months[mk]=true;else delete this.nurseModal.data.night_months[mk]},
    openNurseModal(nurse){
      this.nurseModal.isNew=!nurse;
      this.nurseModal.data=nurse?JSON.parse(JSON.stringify(nurse)):{id:crypto.randomUUID(),name:'',group:'',gender:'female',capable_shifts:['DC','D','EC','E','NC','N'],is_night_shift:false,night_months:{},seniority:this.nurses.length,wishes:{},juhu_day:null,juhu_auto_rotate:true,is_trainee:false,training_end_date:null,preceptor_id:null};
      this.nurseModal.open=true;
    },
    toggleShift(s){const arr=this.nurseModal.data.capable_shifts;const idx=arr.indexOf(s);if(idx>=0)arr.splice(idx,1);else arr.push(s)},
    async saveNurse(){if(!this.nurseModal.data.name.trim()){this.toast('이름을 입력하세요','error');return}await this.api('POST','/api/nurses',this.nurseModal.data);await this.loadNurses();this.nurseModal.open=false},
    async removeNurse(id){if(!confirm('삭제하시겠습니까?'))return;await this.api('DELETE',`/api/nurses/${id}`);await this.loadNurses()},

    // ── 규칙 ──────────────────────────────────────────────────
    async loadRules(){this.rules=await this.api('GET','/api/rules')},
    async saveRules(){await this.api('POST','/api/rules',this.rules);this.toast('규칙이 저장되었습니다','info')},

    // ── 요구사항 ──────────────────────────────────────────────
    async loadRequirements(){this.requirements=await this.api('GET','/api/requirements')},
    async saveRequirements(){await this.api('POST','/api/requirements',this.requirements);this.toast('인원 설정이 저장되었습니다','info')},

    // ── 근무 관리 ─────────────────────────────────────────────
    async loadShifts(){this.shifts=await this.api('GET','/api/shifts')},
    getShiftStyle(code){
      // 트레이니 /D → D로 매핑
      const baseCode=code?.startsWith('/')?code.slice(1):code;
      const s=this.shiftMap.get(baseCode);if(!s)return {};
      if(code?.startsWith('/')){
        // 트레이니: 반투명 스타일
        if(!this.darkMode)return{background:s.color_bg+'80',color:s.color_text+'99',fontStyle:'italic'};
        return{background:this._shiftGlassBg(s.color_bg),color:this._shiftGlassText(s.color_text),opacity:'0.6',fontStyle:'italic'};
      }
      if(!this.darkMode)return{background:s.color_bg,color:s.color_text};
      return{background:this._shiftGlassBg(s.color_bg),color:this._shiftGlassText(s.color_text)};
    },
    // 스케줄 탭용 셀 스타일
    hideCharge:false, colorByShift:false,
    _getShift(nurseId, day){
      const k=this.dayKey(day);
      const s=this.schedule?.[nurseId]?.[k];
      if(s)return s;
      return this.extendedSchedule?.[nurseId]?.[k]||'';
    },
    getScheduleCellClass(nurseId, day){
      const shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return '';
      const k=this.dayKey(day);
      const isPre=!!(this.prevSchedule[nurseId]&&this.prevSchedule[nurseId][k]);
      if(isPre)return 'g-cell-pre';
      if(this.colorByShift)return '';
      const s=this.shiftMap.get(shift);
      if(!s)return '';
      if(s.period==='rest'||s.period==='leave')return 'g-cell-rest';
      return 'g-cell-work';
    },
    getScheduleCellStyle(nurseId, day){
      if(!this.colorByShift)return {};
      let shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return {};
      const k=this.dayKey(day);
      const isPre=!!(this.prevSchedule[nurseId]&&this.prevSchedule[nurseId][k]);
      if(isPre)return {};
      if(this.hideCharge){if(shift==='DC')shift='D';if(shift==='EC')shift='E';if(shift==='NC')shift='N'}
      return this.getShiftStyle(shift);
    },
    displayShift(nurseId, day){
      let shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return '';
      if(this.hideCharge){if(shift==='DC')shift='D';if(shift==='EC')shift='E';if(shift==='NC')shift='N'}
      return shift;
    },
    _hexToHsl(hex){
      if(!hex||!hex.startsWith('#')||hex.length<7)return[0,0,50];
      const r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255;
      const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0,l=(max+min)/2;
      if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break}}
      return[h*360,s*100,l*100];
    },
    // 톤온톤: 투명한 배경 + 밝은 텍스트 (다크 글래스 위)
    _shiftGlassBg(hex){const[h,s]=this._hexToHsl(hex);return`hsla(${h},${Math.min(s,60)}%,50%,0.15)`},
    _shiftGlassText(hex){const[h,s]=this._hexToHsl(hex);return`hsl(${h},${Math.min(s*1.1,70)}%,75%)`},
    // v2 호환용 (미사용이지만 보존)
    _shiftDarkBg(hex){const[h,s]=this._hexToHsl(hex);return`hsl(${h},${Math.max(s*0.8,35)}%,20%)`},
    _shiftDarkText(hex){const[h,s]=this._hexToHsl(hex);return`hsl(${h},${Math.min(s*1.2,80)}%,78%)`},
    openShiftModal(shift){
      this.shiftModal.isNew=!shift;
      this.shiftModal.data=shift?JSON.parse(JSON.stringify(shift)):{code:'',name:'',period:'day',is_charge:false,auto_assign:true,hours:'',color_bg:'#dbeafe',color_text:'#1d4ed8',sort_order:this.shifts.length};
      this.shiftModal.open=true;
    },
    async saveShift(){const d=this.shiftModal.data;if(!d.code.trim()){this.toast('코드를 입력하세요','error');return}if(!d.name.trim()){this.toast('이름을 입력하세요','error');return}await this.api('POST','/api/shifts',d);await this.loadShifts();this.shiftModal.open=false},
    async deleteShift(code){
      const PROTECTED=['DC','D','D1','EC','E','중','NC','N','OF','주'];
      if(PROTECTED.includes(code)){this.toast('기본 근무는 삭제할 수 없습니다','error');return}
      if(!confirm(`'${code}' 근무를 삭제하시겠습니까?`))return;await this.api('DELETE',`/api/shifts/${code}`);await this.loadShifts();
    },

    // ── 배점 관리 ─────────────────────────────────────────────
    async loadScoringRules(){this.scoringRules=await this.api('GET','/api/scoring_rules')},
    scoringRuleTypeLabel(rt){return{transition:'전환 패턴',pattern:'N일 패턴',consecutive_same:'연속 동일',specific_shift:'특정 근무',wish:'희망 근무',night_fairness:'야간 공평성',holiday_work:'공휴일 근무',weekend_work:'주말 근무',holiday_off:'공휴일 OFF'}[rt]||rt},
    scoringRuleCondSummary(r){
      const p=r.params||{};const gl=v=>({work:'모든근무',day:'낮',evening:'저녁',night:'야간',rest:'휴무',leave:'휴가',rest_leave:'휴무/휴가',any:'전체'})[v]||v;
      if(r.rule_type==='transition')return`${gl(p.from)} → ${gl(p.to)}`;
      if(r.rule_type==='pattern')return(p.pattern||[]).map(v=>({work:'근무',day:'낮',evening:'저녁',night:'야간',rest:'휴무',leave:'휴가',rest_leave:'휴무/휴가',any:'전체'})[v]||v).join(' → ');
      if(r.rule_type==='consecutive_same')return`연속 ${gl(p.period)} 쌍`;
      if(r.rule_type==='specific_shift')return`${p.shift_code||'-'}${p.condition==='female_only'?' (여성)':''}`;
      if(r.rule_type==='wish')return'희망 근무 매칭';
      if(r.rule_type==='night_fairness')return'야간 range 최소화';
      if(r.rule_type==='holiday_work')return'공휴일 근무 시 가점';
      if(r.rule_type==='holiday_off')return'공휴일 OFF 시 감점';
      if(r.rule_type==='weekend_work'){const s=p.slots||[];const dnames=['월','화','수','목','금','토','일'];const pnames={day:'D',evening:'E',night:'N'};return s.map(sl=>`${dnames[sl.weekday]} ${(sl.periods||[]).map(pp=>pnames[pp]||pp).join('/')}`).join(', ')||'-'}
      return'-';
    },
    openScoringModal(rule){
      this.scoringModal.isNew=!rule;
      if(rule)this.scoringModal.data=JSON.parse(JSON.stringify(rule));
      else this.scoringModal.data={name:'',rule_type:'transition',score:0,enabled:true,sort_order:this.scoringRules.length,params:{from:'day',to:'night'}};
      this.scoringModal.open=true;
    },
    initScoringParams(rt){
      if(rt==='transition')this.scoringModal.data.params={from:'day',to:'night'};
      else if(rt==='pattern')this.scoringModal.data.params={pattern:['work','rest_leave','work']};
      else if(rt==='consecutive_same')this.scoringModal.data.params={period:'day'};
      else if(rt==='specific_shift')this.scoringModal.data.params={shift_code:this.shifts[0]?.code||'V',condition:'all'};
      else if(rt==='holiday_work')this.scoringModal.data.params={};
      else if(rt==='holiday_off')this.scoringModal.data.params={};
      else if(rt==='weekend_work')this.scoringModal.data.params={slots:[{weekday:5,periods:['evening','night']},{weekday:6,periods:['day']}]};
      else this.scoringModal.data.params={};
    },
    async saveScoringRule(){const d=this.scoringModal.data;if(!d.name.trim()){this.toast('규칙 이름을 입력하세요','error');return}await this.api('POST','/api/scoring_rules',d);await this.loadScoringRules();this.scoringModal.open=false},
    async toggleScoringRule(rule){await this.api('POST','/api/scoring_rules',{...rule,enabled:!rule.enabled});await this.loadScoringRules()},
    async deleteScoringRule(id){if(!confirm('이 배점 규칙을 삭제하시겠습니까?'))return;await this.api('DELETE',`/api/scoring_rules/${id}`);await this.loadScoringRules()},

    // ── 스케줄 생성 ──────────────────────────────────────────
    async generate(){
      if(this.nurses.length===0){this.toast('간호사를 먼저 등록해주세요','error');return}
      if(this._recoverPoll){clearInterval(this._recoverPoll);this._recoverPoll=null}
      this.generating=true;this.stopRequested=false;this.mipGapPercent=null;this.scheduleStopped=false;
      this.statusMessage='';this.estimatedSeconds=0;this.generateStartTime=Date.now();this.generateElapsed=0;
      this.generateTimer=setInterval(()=>{this.generateElapsed=Math.floor((Date.now()-this.generateStartTime)/1000)},1000);
      this.solveProgress={gap_percent:null,nodes:0,has_solution:false,is_running:false};
      this.solverLogs=[];this._logSeq=0;
      this.sseSource=new EventSource('/api/generate/stream');
      this.sseSource.onmessage=(e)=>{
        const data=JSON.parse(e.data);
        if(data.type==='log'){this.solverLogs.push({id:++this._logSeq,msg:data.msg});if(this.solverLogs.length>300)this.solverLogs=this.solverLogs.slice(-200);this.$nextTick(()=>{const el=document.getElementById('logPanel');if(el)el.scrollTop=el.scrollHeight})}
        else if(data.type==='progress')this.solveProgress=data;
        else if(data.type==='done'){this.sseSource.close();this.sseSource=null}
      };
      const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:this.mipGap,time_limit:this.generateTimeout*60,allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,unlimited_v:this.unlimitedV};
      this.api('POST','/api/estimate',payload).then(est=>{if(est&&est.estimated_seconds)this.estimatedSeconds=est.estimated_seconds}).catch(()=>{});
      try{
        const result=await this.api('POST','/api/generate',payload);
        this.statusOk=result.success;this.statusMessage=result.message;
        if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.relaxedCells=result.relaxed_cells||{};this.activeTab='schedule';
          if(result.stopped)this.statusMessage+='\n⏹ 중지 요청으로 탐색 종료 — 현재까지 찾은 최선의 해를 표시합니다.';
          // 완화된 셀 상세 메시지
          if(Object.keys(this.relaxedCells).length>0){
            const details=[];
            for(const[nid,cells]of Object.entries(this.relaxedCells)){
              const nurse=this.nurses.find(n=>n.id===nid);
              const name=nurse?nurse.name:nid;
              for(const[dk,info]of Object.entries(cells)){
                const dateStr=dk.slice(5).replace('-','/');
                details.push(`  ${name} ${dateStr}: ${info.original} → ${info.assigned}`);
              }
            }
            this.statusMessage+='\n\n📋 변경 상세:\n'+details.join('\n');
          }
          this.trackEdits();
          if(result.warning){this.statusMessage=result.warning+'\n\n'+this.statusMessage;this.statusOk=false}}
      }catch(e){this.statusOk=false;this.statusMessage='서버 오류: '+e.message}
      finally{this.generating=false;this.stopRequested=false;if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}if(this.sseSource){this.sseSource.close();this.sseSource=null}this.generateFinalElapsed=this.generateElapsed}
    },
    async stopGenerate(){
      if(this.stopRequested)return;this.stopRequested=true;
      if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}
      if(this.sseSource){this.sseSource.close();this.sseSource=null}
      try{await fetch('/api/generate/stop',{method:'POST'})}catch(e){}
    },

    // ── 표시 헬퍼 ─────────────────────────────────────────────
    getShift(nurseId,day){const key=`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`;return(this.schedule[nurseId]&&this.schedule[nurseId][key])||'-'},
    getDayClass(day){const dow=day.getDay();if(dow===0)return'text-red-500';if(dow===6)return'text-blue-500';return''},
    _CYCLE_REF:new Date(2026,2,1),
    _daysSinceRef(day){return Math.round((day-this._CYCLE_REF)/86400000)},
    getCycleNum(day){const d=this._daysSinceRef(day);return Math.floor(((d%28)+28)%28/7)+1},
    getCycleSpans(){
      const days=this.scheduleDays;if(!days.length)return[];
      const result=[];let cur={cycle:this.getCycleNum(days[0]),count:0,key:days[0].getDate()};
      for(const d of days){const c=this.getCycleNum(d);if(c!==cur.cycle){result.push(cur);cur={cycle:c,count:0,key:d.getDate()}}cur.count++}
      result.push(cur);return result;
    },
    getCycleClass(cycle){return['cy-1','cy-2','cy-3','cy-4'][cycle-1]},
    isCycleStart(day){return((this._daysSinceRef(day)%7)+7)%7===0},
    countShifts(nurseId,shifts){if(!this.schedule[nurseId])return 0;return Object.values(this.schedule[nurseId]).filter(v=>shifts.includes(v)).length},
    nurseScore(nurseId){return this.nurseScores[nurseId]??''},
    openScoreDetail(nurse){this.scoreDetailModal={open:true,nurseName:nurse.name,rows:this.nurseScoreDetails[nurse.id]||[],total:this.nurseScores[nurse.id]??0}},

    // ── 다크모드 ──────────────────────────────────────────────
    toggleDark(){this.darkMode=!this.darkMode;document.documentElement.classList.toggle('dark',this.darkMode);localStorage.setItem('darkMode',this.darkMode)},
    getDayDutyCount(day,shifts){if(!this.schedule||Object.keys(this.schedule).length===0)return 0;const k=this.dayKey(day);return Object.values(this.schedule).filter(ns=>shifts.includes(ns[k])).length},

    // ── 년월 이동 ─────────────────────────────────────────────
    prevMonth(){if(this.month===1){this.month=12;this.year--}else this.month--},
    nextMonth(){if(this.month===12){this.month=1;this.year++}else this.month++},
    dayKey(day){return`${day.getFullYear()}-${String(day.getMonth()+1).padStart(2,'0')}-${String(day.getDate()).padStart(2,'0')}`},

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
      if(isNaN(num)||val===''||val===null){delete this.prevDayReqs[k][type];if(Object.keys(this.prevDayReqs[k]).length===0)delete this.prevDayReqs[k]}
      else this.prevDayReqs[k][type]=num;
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
      await this.api('POST','/api/schedules',{year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,schedule:this.schedule,name:name||null,solver_log:this.solverLogs.map(l=>l.msg).join('\n'),prev_schedule:this.prevSchedule,nurse_scores:this.nurseScores,nurse_score_details:this.nurseScoreDetails});
      await this.loadSavedList();this.toast('저장되었습니다','info');
    },
    async loadSavedList(){this.savedSchedules=await this.api('GET','/api/schedules')},
    async loadSaved(id){const data=await this.api('GET',`/api/schedules/${id}`);this.year=data.data.year||data.year;this.month=data.data.month||data.month;this.nurses=data.data.nurses||[];this.requirements=data.data.requirements||this.requirements;this.rules=data.data.rules||this.rules;this.schedule=data.data.schedule||{};this.prevSchedule=data.data.prev_schedule||{};this.nurseScores=data.data.nurse_scores||{};this.nurseScoreDetails=data.data.nurse_score_details||{};const log=data.data.solver_log||'';if(log){this.solverLogs=log.split('\n').map((m,i)=>({id:i+1,msg:m}))}this.activeTab='schedule'},
    async deleteSaved(id){if(!confirm('삭제하시겠습니까?'))return;await this.api('DELETE',`/api/schedules/${id}`);await this.loadSavedList()},

    // ── 사전입력 저장 ────────────────────────────────────────
    async loadPrevSavesList(){this.prevSaves=await this.api('GET','/api/prev_schedules')},
    async savePrevToServer(){
      const name=this.prevSaveName.trim()||`${this.year}년 ${this.month}월 사전입력`;
      if(!Object.keys(this.prevSchedule).some(k=>Object.keys(this.prevSchedule[k]).length>0)){this.toast('저장할 사전입력 데이터가 없습니다','info');return}
      await this.api('POST','/api/prev_schedules',{year:this.year,month:this.month,name,data:{schedule:this.prevSchedule,day_reqs:this.prevDayReqs,holidays:this.holidays,prev_month_nights:this.prevMonthNights}});
      this.prevSaveName='';await this.loadPrevSavesList();
    },
    async loadPrevFromServer(id){
      const result=await this.api('GET',`/api/prev_schedules/${id}`);this.year=result.year;this.month=result.month;
      if(result.data&&result.data.schedule!==undefined){this.prevSchedule=result.data.schedule;this.prevDayReqs=result.data.day_reqs||{};this.holidays=result.data.holidays||[];this.prevMonthNights=result.data.prev_month_nights||{}}
      else{this.prevSchedule=result.data;this.prevDayReqs={};this.holidays=[];this.prevMonthNights={}}
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
    get traineeShifts(){
      // /D, /E, /N, /주, /OF, /D1 + 여성이면 /생
      const base=['/D','/E','/N','/주','/OF','/D1'];
      if(this.shiftEdit.nurse?.gender==='female')base.push('/생');
      return base;
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
    _pushUndo(){
      this._undoStack.push(JSON.stringify({ps:this.prevSchedule,dr:this.prevDayReqs,hd:this.holidays,lk:this.lockedCells,nt:this.cellNotes}));
      if(this._undoStack.length>this._maxUndo)this._undoStack.shift();
      this._redoStack=[];
    },
    undo(){
      if(!this._undoStack.length)return;
      this._redoStack.push(JSON.stringify({ps:this.prevSchedule,dr:this.prevDayReqs,hd:this.holidays,lk:this.lockedCells,nt:this.cellNotes}));
      const state=JSON.parse(this._undoStack.pop());
      this.prevSchedule=state.ps;this.prevDayReqs=state.dr;this.holidays=state.hd;
      this.lockedCells=state.lk||{};this.cellNotes=state.nt||{};
      this._checkViolations();
    },
    redo(){
      if(!this._redoStack.length)return;
      this._undoStack.push(JSON.stringify({ps:this.prevSchedule,dr:this.prevDayReqs,hd:this.holidays,lk:this.lockedCells,nt:this.cellNotes}));
      const state=JSON.parse(this._redoStack.pop());
      this.prevSchedule=state.ps;this.prevDayReqs=state.dr;this.holidays=state.hd;
      this.lockedCells=state.lk||{};this.cellNotes=state.nt||{};
      this._checkViolations();
    },

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
      const eveningCodes=this.shifts.filter(s=>s.period==='evening'||s.period==='middle').map(s=>s.code);
      const nightCodes=this.shifts.filter(s=>s.period==='night').map(s=>s.code);
      const dayCodes=this.shifts.filter(s=>s.period==='day'||s.period==='day1').map(s=>s.code);

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

          if(eveningCodes.includes(s1)&&dayCodes.includes(s2))
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (E→D 금지)`});
          if(nightCodes.includes(s1)&&dayCodes.includes(s2))
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (N→D 금지)`});
          if(nightCodes.includes(s1)&&eveningCodes.includes(s2))
            v.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (N→E 금지)`});
        }
      }
      this.prevViolations=v;
      this._violationSet=new Set(v.map(x=>`${x.nid}|${x.dk}`));
    },
    hasViolation(nurseId,day){
      return this._violationSet?.has(`${nurseId}|${this.dayKey(day)}`)||false;
    },

    // ── 드래그 다중 선택 ───────────────────────────────────
    onCellMouseDown(nurse,day,event){
      if(event.button!==0)return;
      this._isDragging=true;
      this._dragStart={nid:nurse.id,day};
      this._dragCells=[{nid:nurse.id,day,dk:this.dayKey(day)}];
    },
    onCellMouseOver(nurse,day){
      if(!this._isDragging)return;
      const dk=this.dayKey(day);
      if(!this._dragCells.some(c=>c.nid===nurse.id&&c.dk===dk)){
        this._dragCells.push({nid:nurse.id,day,dk});
      }
    },
    onCellMouseUp(){
      if(!this._isDragging)return;
      this._isDragging=false;
      if(this._dragCells.length>1){
        // 다중 선택 → 근무 선택 모달
        this.shiftEdit={open:true,nurse:this._dragCells[0],day:this._dragCells[0].day,dateLabel:`${this._dragCells.length}셀 선택`,mode:'prev_multi'};
      }else if(this._dragCells.length===1){
        const c=this._dragCells[0];
        const nurse=this.nurses.find(n=>n.id===c.nid);
        if(nurse)this.openPrevEdit(nurse,c.day);
      }
      this._dragStart=null;
    },
    isDragSelected(nurseId,day){
      if(!this._isDragging)return false;
      const dk=this.dayKey(day);
      return this._dragCells.some(c=>c.nid===nurseId&&c.dk===dk);
    },
    applyMultiShiftEdit(shift){
      if(shift==='__CLEAR__'){
        this._pushUndo();
        for(const c of this._dragCells){
          if(this.prevSchedule[c.nid])delete this.prevSchedule[c.nid][c.dk];
        }
      }else{
        this._pushUndo();
        for(const c of this._dragCells){
          if(!this.prevSchedule[c.nid])this.prevSchedule[c.nid]={};
          this.prevSchedule[c.nid][c.dk]=shift;
        }
      }
      this._dragCells=[];
      this.shiftEdit.open=false;
      this._checkViolations();
    },

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
        const shiftMap={'D':'D','E':'E','N':'N','V':'V','O':'OF'};
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
      this.noteEdit={open:true,nurseId,dk,text:(this.cellNotes[nurseId]?.[dk])||''};
    },
    saveNote(){
      const{nurseId,dk,text}=this.noteEdit;
      if(!this.cellNotes[nurseId])this.cellNotes[nurseId]={};
      if(text.trim())this.cellNotes[nurseId][dk]=text.trim();
      else{delete this.cellNotes[nurseId][dk];if(!Object.keys(this.cellNotes[nurseId]).length)delete this.cellNotes[nurseId]}
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
      // type: 'D','E','N' — 해당 시간대에 배정된 사전입력 간호사 수
      const dk=this.dayKey(day);
      const periodShifts={
        D: this.shifts.filter(s=>s.period==='day'||s.period==='day1').map(s=>s.code),
        E: this.shifts.filter(s=>s.period==='evening'||s.period==='middle').map(s=>s.code),
        N: this.shifts.filter(s=>s.period==='night').map(s=>s.code),
      };
      const codes=periodShifts[type]||[];
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

    // ── 분석 탭 ─────────────────────────────────────────────
    runAnalysis(){
      this.analysisRunning=true;
      try{
        this.analysisResult=this._analyzeStaffing();
        this.juhuRecommendation=this._recommendJuhu(this.analysisResult);
      }catch(e){console.error('Analysis error:',e);this.analysisResult=null;this.juhuRecommendation=null}
      this.analysisRunning=false;
    },

    _getReqForDay(day){
      const wk=this.getDayWeekKey(day);
      const base=this.requirements[wk]||{};
      const dk=this.dayKey(day);
      const override=this.prevDayReqs[dk]||{};
      const D=(override.D!==undefined?override.D:base.D)||0;
      const E=(override.E!==undefined?override.E:base.E)||0;
      const N=(override.N!==undefined?override.N:base.N)||0;
      return {D,E,N,total:D+E+N};
    },

    _analyzeStaffing(){
      const days=this.scheduleDays;
      const totalNurses=this.nurses.length;
      const first=new Date(this.year,this.month-1,1);
      const last=new Date(this.year,this.month,0);
      const dayNames=['일','월','화','수','목','금','토'];

      // 시프트 분류
      const restCodes=this.shifts.filter(s=>s.period==='rest').map(s=>s.code);
      const leaveCodes=this.shifts.filter(s=>s.period==='leave').map(s=>s.code);
      const offCodes=[...restCodes,...leaveCodes];

      const dayAnalysis=[];
      for(const day of days){
        const isThisMonth=day.getMonth()===this.month-1&&day.getFullYear()===this.year;
        const dk=this.dayKey(day);
        const req=this._getReqForDay(day);

        // 사전입력 카운트
        let preWork=0,preRest=0,preLeave=0,preJuhu=0,preOF=0;
        for(const nurse of this.nurses){
          const val=(this.prevSchedule[nurse.id]||{})[dk];
          if(!val)continue;
          if(val==='주')preJuhu++;
          else if(val==='OF')preOF++;
          else if(restCodes.includes(val))preRest++;
          else if(leaveCodes.includes(val))preLeave++;
          else preWork++;
        }
        const preFixed=preWork+preRest+preLeave+preJuhu+preOF;
        const freeNurses=totalNurses-preFixed;
        const remainReq=Math.max(0,req.total-preWork);
        const slack=freeNurses-remainReq;

        dayAnalysis.push({
          day, dk, isThisMonth,
          date:day.getDate(),
          dow:day.getDay(),
          dowName:dayNames[day.getDay()],
          reqD:req.D, reqE:req.E, reqN:req.N, reqTotal:req.total,
          preWork, preRest, preLeave, preJuhu, preOF, preFixed,
          freeNurses, remainReq, slack,
          weekIdx:Math.floor(this._daysSinceRef(day)/7),
          cycle:this.getCycleNum(day),
        });
      }

      // 주별 집계 (모든 주기 날짜 포함 — overflow 포함)
      const weekMap=new Map();
      for(const da of dayAnalysis){
        if(!weekMap.has(da.weekIdx))weekMap.set(da.weekIdx,{weekIdx:da.weekIdx,cycle:da.cycle,days:[],totalReq:0,totalSlack:0,juhuAssigned:0,ofAssigned:0});
        const w=weekMap.get(da.weekIdx);
        w.days.push(da);
        w.totalReq+=da.reqTotal;w.totalSlack+=da.slack;w.juhuAssigned+=da.preJuhu;w.ofAssigned+=da.preOF;
      }
      const weeks=[...weekMap.values()].sort((a,b)=>a.weekIdx-b.weekIdx);

      // 경고 (모든 날짜 대상)
      const warnings=[];
      for(const da of dayAnalysis){
        if(da.slack<0)warnings.push({type:'danger',msg:`${da.day.getMonth()+1}/${da.date}(${da.dowName}) 인원 부족: 필요 ${da.reqTotal}명, 가용 ${da.freeNurses+da.preWork}명`});
        else if(da.slack<2)warnings.push({type:'warn',msg:`${da.day.getMonth()+1}/${da.date}(${da.dowName}) 여유 부족 (${da.slack}명) — 주휴/OF 배치 공간 빡빡`});
      }

      return {days:dayAnalysis, weeks, warnings, totalNurses};
    },

    _recommendJuhu(analysis){
      if(!analysis)return null;
      const {days,weeks,totalNurses}=analysis;
      const nurses=this.nurses;
      const assignments={};
      const warnings=[];

      // 일자별 동적 여유도 (추천할 때마다 갱신)
      const daySlack={};
      for(const da of days){
        daySlack[da.dk]={...da,currentSlack:da.slack};
      }

      // 주를 4주 period로 그룹핑
      const periodMap=new Map();
      for(const week of weeks){
        const period=Math.floor(week.weekIdx/4);
        if(!periodMap.has(period))periodMap.set(period,[]);
        periodMap.get(period).push(week);
      }
      const periods=[...periodMap.entries()].sort((a,b)=>a[0]-b[0]);

      // 1단계: 이미 사전입력된 주휴 수집
      const nurseExistingJuhu={};  // nurseId → Set of weekIdx
      for(const nurse of nurses){
        nurseExistingJuhu[nurse.id]=new Set();
        for(const week of weeks){
          for(const wd of week.days){
            const val=(this.prevSchedule[nurse.id]||{})[wd.dk];
            if(val==='주'){
              nurseExistingJuhu[nurse.id].add(week.weekIdx);
              if(!assignments[nurse.id])assignments[nurse.id]=[];
              assignments[nurse.id].push({day:wd.day,dk:wd.dk,date:wd.date,dow:wd.dow,dowName:wd.dowName,cycle:wd.cycle,weekIdx:week.weekIdx,existing:true});
            }
          }
        }
      }

      // 2단계: juhu_day 설정된 간호사 — 4주 동일 요일 + period 간 -1 시프트
      const nurseAssignedWeeks={};  // nurseId → Set of weekIdx (배정 완료)
      for(const n of nurses)nurseAssignedWeeks[n.id]=new Set(nurseExistingJuhu[n.id]);

      for(const nurse of nurses){
        const jd=nurse.juhu_day;
        if(jd===null||jd===undefined)continue;

        for(const[periodIdx,periodWeeks]of periods){
          for(const week of periodWeeks){
            if(nurseAssignedWeeks[nurse.id].has(week.weekIdx))continue;
            const weekDays=week.days;
            if(!weekDays.length)continue;

            let effectiveDay=jd;
            if(nurse.juhu_auto_rotate!==false){
              effectiveDay=((jd-periodIdx)%7+7)%7;
            }
            const target=weekDays.find(d=>d.dow===effectiveDay);
            if(target&&daySlack[target.dk]&&daySlack[target.dk].currentSlack>0){
              if(!assignments[nurse.id])assignments[nurse.id]=[];
              assignments[nurse.id].push({day:target.day,dk:target.dk,date:target.date,dow:target.dow,dowName:target.dowName,cycle:target.cycle,weekIdx:week.weekIdx,existing:false});
              daySlack[target.dk].currentSlack--;
              nurseAssignedWeeks[nurse.id].add(week.weekIdx);
            }
          }
        }
      }

      // 3단계: juhu_day 없는 간호사 — 첫 period에서 최적 요일 선정 후 4주 유지, 다음 period에서 -1
      const unsetNurses=nurses.filter(n=>n.juhu_day===null||n.juhu_day===undefined);

      // 첫 period에서 요일별 여유도 합산 → 가장 여유로운 요일부터 배정
      if(unsetNurses.length>0&&periods.length>0){
        const firstPeriodIdx=periods[0][0];
        const firstPeriodWeeks=periods[0][1];

        // 요일별 누적 여유도 계산 (첫 period 기준)
        const dowSlackSum={};  // dow → 총 여유도
        for(let dow=0;dow<7;dow++)dowSlackSum[dow]=0;
        for(const week of firstPeriodWeeks){
          for(const wd of week.days){
            dowSlackSum[wd.dow]+=(daySlack[wd.dk]?.currentSlack||0);
          }
        }

        // 각 간호사에게 요일 배정 (여유도 + 그룹 균형 고려)
        const dowAssignCount={};  // dow → 배정된 간호사 수
        const dowGroupCount={};   // dow → { groupName → count }
        for(let dow=0;dow<7;dow++){dowAssignCount[dow]=0;dowGroupCount[dow]={}}

        // 간호사를 미배정 주 많은 순으로 정렬
        const sortedUnset=[...unsetNurses].sort((a,b)=>{
          const aUnassigned=weeks.filter(w=>!nurseAssignedWeeks[a.id].has(w.weekIdx)&&w.days.length>0).length;
          const bUnassigned=weeks.filter(w=>!nurseAssignedWeeks[b.id].has(w.weekIdx)&&w.days.length>0).length;
          return bUnassigned-aUnassigned;
        });

        for(const nurse of sortedUnset){
          // 이미 모든 주에 주휴 배정 완료된 간호사는 스킵
          const hasUnassigned=weeks.some(w=>!nurseAssignedWeeks[nurse.id].has(w.weekIdx)&&w.days.length>0);
          if(!hasUnassigned)continue;

          const nurseGroup=nurse.group||'';
          const candidates=[];
          for(let dow=0;dow<7;dow++){
            let feasibleWeeks=0;
            for(const[periodIdx,periodWeeks]of periods){
              const shiftedDow=((dow-(periodIdx-firstPeriodIdx))%7+7)%7;
              for(const week of periodWeeks){
                if(nurseAssignedWeeks[nurse.id].has(week.weekIdx))continue;
                const wd=week.days.find(d=>d.dow===shiftedDow);
                if(wd&&daySlack[wd.dk]&&daySlack[wd.dk].currentSlack>0)feasibleWeeks++;
              }
            }
            if(feasibleWeeks===0)continue;

            // 점수: 여유도 합 - 총 배정 수 페널티 - 같은 그룹 배정 수 페널티 (그룹 균형)
            const sameGroupOnDow=dowGroupCount[dow][nurseGroup]||0;
            const score=dowSlackSum[dow]-dowAssignCount[dow]*2-sameGroupOnDow*4;
            candidates.push({dow,score,feasibleWeeks});
          }

          if(candidates.length===0){
            warnings.push({type:'danger',msg:`${nurse.name}: 주휴 배정 가능한 요일이 없습니다`});
            continue;
          }

          // 최고 점수 요일 선택
          candidates.sort((a,b)=>b.score-a.score||b.feasibleWeeks-a.feasibleWeeks);
          const chosenDow=candidates[0].dow;
          dowAssignCount[chosenDow]++;
          if(!dowGroupCount[chosenDow][nurseGroup])dowGroupCount[chosenDow][nurseGroup]=0;
          dowGroupCount[chosenDow][nurseGroup]++;

          // 모든 period에 걸쳐 배정 (4주 동일 요일, period 간 -1 시프트)
          for(const[periodIdx,periodWeeks]of periods){
            const shiftedDow=((chosenDow-(periodIdx-firstPeriodIdx))%7+7)%7;
            for(const week of periodWeeks){
              if(nurseAssignedWeeks[nurse.id].has(week.weekIdx))continue;
              const weekDays=week.days;
              if(!weekDays.length)continue;

              const target=weekDays.find(d=>d.dow===shiftedDow);
              if(target&&daySlack[target.dk]&&daySlack[target.dk].currentSlack>0){
                if(!assignments[nurse.id])assignments[nurse.id]=[];
                assignments[nurse.id].push({day:target.day,dk:target.dk,date:target.date,dow:target.dow,dowName:target.dowName,cycle:target.cycle,weekIdx:week.weekIdx,existing:false});
                daySlack[target.dk].currentSlack--;
                nurseAssignedWeeks[nurse.id].add(week.weekIdx);
              }else if(target){
                // 여유 없으면 같은 주 다른 날 중 가장 여유로운 날 대체
                const fallback=weekDays
                  .filter(d=>daySlack[d.dk]&&daySlack[d.dk].currentSlack>0)
                  .sort((a,b)=>daySlack[b.dk].currentSlack-daySlack[a.dk].currentSlack);
                if(fallback.length>0){
                  const fb=fallback[0];
                  if(!assignments[nurse.id])assignments[nurse.id]=[];
                  assignments[nurse.id].push({day:fb.day,dk:fb.dk,date:fb.date,dow:fb.dow,dowName:fb.dowName,cycle:fb.cycle,weekIdx:week.weekIdx,existing:false});
                  daySlack[fb.dk].currentSlack--;
                  nurseAssignedWeeks[nurse.id].add(week.weekIdx);
                  warnings.push({type:'warn',msg:`${nurse.name}: ${fb.cycle}주기 ${fb.date}일 — 요일 변경 (여유 부족)`});
                }else{
                  warnings.push({type:'danger',msg:`${nurse.name}: ${week.cycle}주기에 주휴 배정 불가`});
                }
              }
            }
          }
        }
      }

      // 추천 후 일별 주휴 수 집계
      const juhuPerDay={};
      for(const[nid,list]of Object.entries(assignments)){
        for(const a of list){
          if(!juhuPerDay[a.dk])juhuPerDay[a.dk]=0;
          juhuPerDay[a.dk]++;
        }
      }

      // 배정 정렬 (날짜순)
      for(const nid of Object.keys(assignments)){
        assignments[nid].sort((a,b)=>a.day-b.day);
      }

      return {assignments,warnings,juhuPerDay};
    },

    applyRecommendedJuhu(){
      if(!this.juhuRecommendation)return;
      const{assignments}=this.juhuRecommendation;
      let count=0;
      for(const[nid,list]of Object.entries(assignments)){
        for(const a of list){
          if(a.existing)continue;
          if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
          this.prevSchedule[nid][a.dk]='주';
          count++;
        }
      }
      if(count===0){this.toast('이미 모든 주휴가 반영되어 있습니다','info');return}
      this.toast(`${count}건의 주휴가 사전입력에 적용되었습니다`,'info');
    },

    getSlackClass(slack){
      if(slack>=4)return'slack-good';
      if(slack>=3)return'slack-ok';
      if(slack>=2)return'slack-tight';
      if(slack>=1)return'slack-warn';
      return'slack-danger';
    },
    getSlackLabel(slack){
      if(slack>=4)return'여유';
      if(slack>=3)return'양호';
      if(slack>=2)return'적정';
      if(slack>=1)return'빡빡';
      return'부족';
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
        const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:Math.max(0.02,this.mipGap+i*0.02),time_limit:Math.min(this.generateTimeout*60,120),allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,unlimited_v:this.unlimitedV};
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

    // ═══ 11. 변경 이력 ════════════════════════════════════
    changeHistory:[],
    _maxHistory:100,
    addHistory(action,detail){
      this.changeHistory.unshift({time:new Date().toLocaleTimeString(),action,detail});
      if(this.changeHistory.length>this._maxHistory)this.changeHistory.pop();
    },

    // ═══ 12. 간호사 그룹별 필터 ══════════════════════════
    groupFilter:'all',
    get filteredNurses(){
      if(this.groupFilter==='all')return this.nurses;
      return this.nurses.filter(n=>n.group===this.groupFilter);
    },
    get nurseGroups(){
      const groups=[...new Set(this.nurses.map(n=>n.group).filter(Boolean))];
      return groups.sort();
    },

    // ═══ 13. 생성 결과 경고 요약 ═════════════════════════
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
    toast(msg,type='info',duration=3000){
      const id=++this._toastId;
      this._toasts.push({id,msg,type});
      setTimeout(()=>{this._toasts=this._toasts.filter(t=>t.id!==id)},duration);
    },

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

    // ═══ 단축키 도움말 ════════════════════════════════════
    showShortcutHelp:false,

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
  };
}
