/* ────────────────────────────────────────────────────────────────────────────
 * 사전입력 그리드 상호작용 — 자동저장·실시간 위반 경고·키보드 네비·셀 잠금·메모·행 복사·희망근무·프리셋 패턴·야간 카운터·편집 래핑·배정 카운트
 *
 * 사용: app() 반환 객체에 `...GridInteractionsModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.GridInteractionsModule = function() {
  return {
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

  };
};
