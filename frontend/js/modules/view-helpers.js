/* ────────────────────────────────────────────────────────────────────────────
 * 표시 헬퍼 — 셀 표시·사이클/요일·근무 카운트·다크모드·년월 이동·오늘(Today) 홈
 *
 * 사용: app() 반환 객체에 `...ViewHelpersModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.ViewHelpersModule = function() {
  return {
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

    // ── 오늘(Today) 홈 헬퍼 ───────────────────────────────────
    todayKey(){return this.dayKey(new Date())},
    _dutyAccept(duty){return duty==='D'?['D','DC','D1']:duty==='E'?['E','EC','중']:['N','NC']},
    todayShiftCount(duty){
      if(!this.schedule)return 0;
      const k=this.todayKey(), acc=this._dutyAccept(duty);
      return Object.values(this.schedule).filter(days=>acc.includes(days[k])).length;
    },
    todayShiftReq(duty){
      const wk=['sun','mon','tue','wed','thu','fri','sat'][new Date().getDay()];
      const r=this.requirements?.[wk]||{};
      if(duty==='D')return (r.DC||0)+(r.D||0);
      if(duty==='E')return (r.EC||0)+(r.E||0);
      return (r.NC||0)+(r.N||0);
    },
    todayNursesByDuty(duty){
      if(!this.schedule)return [];
      const k=this.todayKey(), acc=this._dutyAccept(duty);
      return Object.entries(this.schedule)
        .filter(([nid,days])=>acc.includes(days[k]))
        .map(([nid,days])=>({nid,code:days[k],nurse:this.nurses.find(n=>n.id===nid)}))
        .filter(x=>x.nurse);
    },

  };
};
