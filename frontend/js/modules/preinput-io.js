/* ────────────────────────────────────────────────────────────────────────────
 * 사전입력 입출력 — 셀 편집·일별 필요인원·법정공휴일·주휴 자동배분·다음달 이월·저장/불러오기·트레이니
 *
 * 사용: app() 반환 객체에 `...PreinputIoModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.PreinputIoModule = function() {
  return {
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

  };
};
