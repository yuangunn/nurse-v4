function app() {
  return {
    // ── 상태 ──────────────────────────────────────────────────
    tabs: [
      {id:'settings', label:'설정',     icon:'settings'},
      {id:'preinput', label:'사전입력', icon:'edit-3'},
      {id:'schedule', label:'스케줄',   icon:'calendar'},
      {id:'saved',    label:'저장',     icon:'save'},
    ],
    activeTab: 'settings',
    fontSize: parseInt(localStorage.getItem('fontSize'))||20,
    year:  new Date().getFullYear(),
    month: new Date().getMonth() + 1,
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
      maxNightPerMonth:true, maxNightPerMonthCount:6,
      maxNightTwoMonth:false, maxNightTwoMonthCount:11,
      patternOptimization:true, autoMenstrualLeave:true, maxVPerMonth:1,
    },
    schedule:{}, extendedSchedule:{},
    generating:false, generateStartTime:null, generateElapsed:0, generateFinalElapsed:0,
    generateTimer:null, sseSource:null, solverLogs:[], showLogPanel:true,
    solveProgress:{gap_percent:null,nodes:0,has_solution:false,is_running:false},
    stopRequested:false, mipGap:0.02, generateTimeout:20, allowPreRelax:false, unlimitedV:false, relaxedCells:{},
    mipGapPercent:null, scheduleStopped:false, estimatedSeconds:0,
    statusMessage:'', statusOk:true, savedSchedules:[],
    darkMode: localStorage.getItem('darkMode')==='true',
    weekdayLabels:{mon:'월',tue:'화',wed:'수',thu:'목',fri:'금',sat:'토',sun:'일'},
    workShifts:['D','E','N'],
    shifts:[], shiftMgmtOpen:true, scoringRuleOpen:true,
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

    // ── computed ──────────────────────────────────────────────
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
      await Promise.all([this.loadNurses(),this.loadRules(),this.loadRequirements(),this.loadShifts(),this.loadScoringRules(),this.loadSavedList(),this.loadPrevSavesList()]);
      this._checkPendingGenerate();
      this.$nextTick(()=>{if(window.lucide)lucide.createIcons()});
    },
    setFontSize(size){this.fontSize=size;localStorage.setItem('fontSize',size);document.documentElement.style.fontSize=size+'px'},

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
              if(r.status==='done'&&r.result){clearInterval(pollRef);if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}if(this.sseSource){this.sseSource.close();this.sseSource=null}this.generating=false;this.generateFinalElapsed=this.generateElapsed;const result=r.result;this.statusOk=result.success;this.statusMessage=result.message;if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true}}
            }catch(e){}
          },2000);
        }else if(res.status==='done'&&res.result){
          const result=res.result;this.statusOk=result.success;this.statusMessage=result.message+'\n(이전 생성 결과 복원됨)';
          if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.relaxedCells=result.relaxed_cells||{};this.activeTab='schedule'}
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
      this.nurseModal.data=nurse?JSON.parse(JSON.stringify(nurse)):{id:crypto.randomUUID(),name:'',group:'',gender:'female',capable_shifts:['DC','D','EC','E','NC','N'],is_night_shift:false,night_months:{},seniority:this.nurses.length,wishes:{},juhu_day:null,juhu_auto_rotate:true};
      this.nurseModal.open=true;
    },
    toggleShift(s){const arr=this.nurseModal.data.capable_shifts;const idx=arr.indexOf(s);if(idx>=0)arr.splice(idx,1);else arr.push(s)},
    async saveNurse(){if(!this.nurseModal.data.name.trim()){alert('이름을 입력하세요.');return}await this.api('POST','/api/nurses',this.nurseModal.data);await this.loadNurses();this.nurseModal.open=false},
    async removeNurse(id){if(!confirm('삭제하시겠습니까?'))return;await this.api('DELETE',`/api/nurses/${id}`);await this.loadNurses()},

    // ── 규칙 ──────────────────────────────────────────────────
    async loadRules(){this.rules=await this.api('GET','/api/rules')},
    async saveRules(){await this.api('POST','/api/rules',this.rules);alert('규칙이 저장되었습니다.')},

    // ── 요구사항 ──────────────────────────────────────────────
    async loadRequirements(){this.requirements=await this.api('GET','/api/requirements')},
    async saveRequirements(){await this.api('POST','/api/requirements',this.requirements);alert('인원 설정이 저장되었습니다.')},

    // ── 근무 관리 ─────────────────────────────────────────────
    async loadShifts(){this.shifts=await this.api('GET','/api/shifts')},
    getShiftStyle(code){
      const s=this.shifts.find(x=>x.code===code);if(!s)return {};
      if(!this.darkMode)return{background:s.color_bg,color:s.color_text};
      return{background:this._shiftGlassBg(s.color_bg),color:this._shiftGlassText(s.color_text)};
    },
    // 스케줄 탭용 셀 스타일
    hideCharge:false, colorByShift:false,
    getScheduleCellClass(nurseId, day){
      const k=this.dayKey(day);const shift=this.schedule?.[nurseId]?.[k];
      if(!shift||shift==='-')return '';
      const isPre=!!(this.prevSchedule[nurseId]&&this.prevSchedule[nurseId][k]);
      if(isPre)return 'g-cell-pre';
      if(this.colorByShift)return '';
      const s=this.shifts.find(x=>x.code===shift);
      if(!s)return '';
      if(s.period==='rest'||s.period==='leave')return 'g-cell-rest';
      return 'g-cell-work';
    },
    getScheduleCellStyle(nurseId, day){
      if(!this.colorByShift)return {};
      const k=this.dayKey(day);let shift=this.schedule?.[nurseId]?.[k];
      if(!shift||shift==='-')return {};
      const isPre=!!(this.prevSchedule[nurseId]&&this.prevSchedule[nurseId][k]);
      if(isPre)return {};
      if(this.hideCharge){if(shift==='DC')shift='D';if(shift==='EC')shift='E';if(shift==='NC')shift='N'}
      return this.getShiftStyle(shift);
    },
    displayShift(nurseId, day){
      const k=this.dayKey(day);let shift=this.schedule?.[nurseId]?.[k];
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
    async saveShift(){const d=this.shiftModal.data;if(!d.code.trim()){alert('코드를 입력하세요.');return}if(!d.name.trim()){alert('이름을 입력하세요.');return}await this.api('POST','/api/shifts',d);await this.loadShifts();this.shiftModal.open=false},
    async deleteShift(code){
      const PROTECTED=['DC','D','D1','EC','E','중','NC','N','OF','주'];
      if(PROTECTED.includes(code)){alert('기본 근무(DC·D·D1·EC·E·중·NC·N·OF·주)는 삭제할 수 없습니다.');return}
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
    async saveScoringRule(){const d=this.scoringModal.data;if(!d.name.trim()){alert('규칙 이름을 입력하세요.');return}await this.api('POST','/api/scoring_rules',d);await this.loadScoringRules();this.scoringModal.open=false},
    async toggleScoringRule(rule){await this.api('POST','/api/scoring_rules',{...rule,enabled:!rule.enabled});await this.loadScoringRules()},
    async deleteScoringRule(id){if(!confirm('이 배점 규칙을 삭제하시겠습니까?'))return;await this.api('DELETE',`/api/scoring_rules/${id}`);await this.loadScoringRules()},

    // ── 스케줄 생성 ──────────────────────────────────────────
    async generate(){
      if(this.nurses.length===0){alert('간호사를 먼저 등록해주세요.');return}
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
      const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:this.mipGap,time_limit:this.generateTimeout*60,allow_pre_relax:this.allowPreRelax,unlimited_v:this.unlimitedV};
      this.api('POST','/api/estimate',payload).then(est=>{if(est&&est.estimated_seconds)this.estimatedSeconds=est.estimated_seconds}).catch(()=>{});
      try{
        const result=await this.api('POST','/api/generate',payload);
        this.statusOk=result.success;this.statusMessage=result.message;
        if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.activeTab='schedule';
          if(result.stopped)this.statusMessage+='\n⏹ 중지 요청으로 탐색 종료 — 현재까지 찾은 최선의 해를 표시합니다.';
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
    clearPrevSchedule(){if(!confirm(`${this.year}년 ${this.month}월 사전입력을 초기화하시겠습니까?\n(해당 월의 모든 주기 포함)`))return;const keys=this._cycleDateKeys();for(const nid of Object.keys(this.prevSchedule)){for(const k of Object.keys(this.prevSchedule[nid])){if(keys.has(k))delete this.prevSchedule[nid][k]}if(!Object.keys(this.prevSchedule[nid]).length)delete this.prevSchedule[nid]}const newDR={};for(const[k,v]of Object.entries(this.prevDayReqs)){if(!keys.has(k))newDR[k]=v}this.prevDayReqs=newDR;this.holidays=this.holidays.filter(h=>!keys.has(h))},
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
        else if(shift==='주'){this.autoFillJuhu(this.shiftEdit.nurse,this.shiftEdit.day)}
        else{if(!this.prevSchedule[nid])this.prevSchedule[nid]={};this.prevSchedule[nid][k]=shift;this.shiftEdit.open=false}
      }else{if(!this.schedule[nid])this.schedule[nid]={};this.schedule[nid][k]=shift;this.shiftEdit.open=false}
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
      if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
      for(const{day}of toFill)this.prevSchedule[nid][this.dayKey(day)]='주';
      this.shiftEdit.open=false;
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
      if(count===0){alert('다음 달로 넘길 데이터가 없습니다.');return}
      this.year=ny;this.month=nm;this.activeTab='preinput';
      alert(`${ny}년 ${nm}월 사전입력에 ${count}건이 추가되었습니다.\n사전입력 탭에서 확인하세요.`);
    },

    // ── 저장/불러오기 ────────────────────────────────────────
    async saveSchedule(){
      const name=prompt('저장 이름을 입력하세요 (선택)',`${this.year}년 ${this.month}월`);if(name===null)return;
      await this.api('POST','/api/schedules',{year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,schedule:this.schedule,name:name||null,solver_log:this.solverLogs.map(l=>l.msg).join('\n'),prev_schedule:this.prevSchedule,nurse_scores:this.nurseScores,nurse_score_details:this.nurseScoreDetails});
      await this.loadSavedList();alert('저장되었습니다.');
    },
    async loadSavedList(){this.savedSchedules=await this.api('GET','/api/schedules')},
    async loadSaved(id){const data=await this.api('GET',`/api/schedules/${id}`);this.year=data.data.year||data.year;this.month=data.data.month||data.month;this.nurses=data.data.nurses||[];this.requirements=data.data.requirements||this.requirements;this.rules=data.data.rules||this.rules;this.schedule=data.data.schedule||{};this.prevSchedule=data.data.prev_schedule||{};this.nurseScores=data.data.nurse_scores||{};this.nurseScoreDetails=data.data.nurse_score_details||{};const log=data.data.solver_log||'';if(log){this.solverLogs=log.split('\n').map((m,i)=>({id:i+1,msg:m}))}this.activeTab='schedule'},
    async deleteSaved(id){if(!confirm('삭제하시겠습니까?'))return;await this.api('DELETE',`/api/schedules/${id}`);await this.loadSavedList()},

    // ── 사전입력 저장 ────────────────────────────────────────
    async loadPrevSavesList(){this.prevSaves=await this.api('GET','/api/prev_schedules')},
    async savePrevToServer(){
      const name=this.prevSaveName.trim()||`${this.year}년 ${this.month}월 사전입력`;
      if(!Object.keys(this.prevSchedule).some(k=>Object.keys(this.prevSchedule[k]).length>0)){alert('저장할 사전입력 데이터가 없습니다.');return}
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
  };
}
