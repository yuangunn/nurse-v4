/* ────────────────────────────────────────────────────────────────────────────
 * 스케줄 생성 + 정밀 충돌 분석 — generate/stopGenerate·diagnoseConflicts·suggestFix·applyFix·jumpToPreCell
 *
 * 사용: app() 반환 객체에 `...SolverModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.SolverModule = function() {
  return {
    // ── 스케줄 생성 ──────────────────────────────────────────
    async generate(){
      if(this.nurses.length===0){this.toast('간호사를 먼저 등록해주세요','error');return}
      if(this._recoverPoll){clearInterval(this._recoverPoll);this._recoverPoll=null}
      this.generating=true;this.stopRequested=false;this.mipGapPercent=null;this.scheduleStopped=false;
      this.diagResult=null;this.fixResult=null;
      this.statusMessage='';this.estimatedSeconds=0;this.generateStartTime=Date.now();this.generateElapsed=0;
      this.generateTimer=setInterval(()=>{this.generateElapsed=Math.floor((Date.now()-this.generateStartTime)/1000)},1000);
      this.solveProgress={gap_percent:null,nodes:0,has_solution:false,is_running:false};
      this.solverLogs=[];this._logSeq=0;
      this.sseSource=new EventSource('/api/generate/stream');
      this.sseSource.onmessage=(e)=>{
        const data=JSON.parse(e.data);
        if(data.type==='log'){this.solverLogs.push({id:++this._logSeq,msg:data.msg});if(this.solverLogs.length>300)this.solverLogs=this.solverLogs.slice(-200);this.$nextTick(()=>{const el=document.getElementById('logPanel');if(el)el.scrollTop=el.scrollHeight})}
        else if(data.type==='hint'){this.solverLogs.push({id:++this._logSeq,msg:data.msg,hint:true})}
        else if(data.type==='progress')this.solveProgress=data;
        else if(data.type==='done'){this.sseSource.close();this.sseSource=null}
      };
      const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,locked_cells:Object.keys(this.lockedCells).length?this.lockedCells:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:this.mipGap,time_limit:this.generateTimeout*60,allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,unlimited_v:this.unlimitedV,solver:this.solver};
      this.api('POST','/api/estimate',payload).then(est=>{if(est&&est.estimated_seconds)this.estimatedSeconds=est.estimated_seconds}).catch(()=>{});
      try{
        const result=await this.api('POST','/api/generate',payload);
        this.statusOk=result.success;this.statusMessage=result.message;
        this.generationReport=result.generation_report||null;
        this.wishReport=result.wish_report||null;
        this.loadFairnessLedger&&this.loadFairnessLedger();
        // 13단계 진단이 짚은 셀 좌표 → 정밀분석과 동일한 '충돌 위치로 이동' 칩 표시
        if(!result.success&&Array.isArray(result.anchored)&&result.anchored.length){this.diagResult={anchored:result.anchored}}
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

    // ── 실시간 생성 가능성 신호등 (사전입력 편집 → 디바운스 프로브) ─────────
    _queueFeasibility(){
      clearTimeout(this._feasTimer);
      this._feasTimer=setTimeout(()=>this._runFeasibility(),1200);
    },
    async _runFeasibility(){
      if(!this.nurses.length)return;
      if(this.generating){this._queueFeasibility();return} // 생성 솔버에 CPU 양보
      const seq=++this._feasSeq;
      this.feas={...(this.feas||{}),checking:true};
      try{
        const res=await this.api('POST','/api/feasibility',this._diagPayload());
        if(seq!==this._feasSeq)return;                     // 이후 편집 발생 — 낡은 응답 폐기
        if(res.status==='busy'){this._queueFeasibility();return}
        this.feas={...res,checking:false};
      }catch(e){if(seq===this._feasSeq)this.feas={status:'unknown',conflicts:[],checking:false}}
    },
    fmtEta(sec){if(!sec)return'';return sec<90?`약 ${sec}초`:`약 ${Math.round(sec/60)}분`},

    // ── 정밀 충돌 분석 (CP-SAT assumptions) ───────────────────
    _diagPayload(){return{year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,locked_cells:Object.keys(this.lockedCells).length?this.lockedCells:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null}},
    async diagnoseConflicts(){
      if(this.diagnosing)return;
      this.diagnosing=true; this.diagResult=null;
      try{
        const res=await this.api('POST','/api/diagnose',this._diagPayload());
        if(res&&res.message){
          this.diagResult=res;
          this.statusMessage=this.statusMessage+'\n\n━━ 정밀 충돌 분석 (CP-SAT) ━━\n'+res.message;
          this.toast(res.conflicts&&res.conflicts.length?`충돌 ${res.conflicts.length}건 발견`:'하드 제약 충돌 없음','info',3500);
        }
      }catch(e){this.toast('충돌 분석 실패','error');}
      finally{this.diagnosing=false;}
    },
    async suggestFix(){
      if(this.fixing)return;
      this.fixing=true; this.fixResult=null;
      try{
        const res=await this.api('POST','/api/suggest-fix',this._diagPayload());
        if(res){
          this.fixResult=res;
          this.toast(res.fixable?'자동 수정 처방을 계산했습니다':'처방 계산 실패 — 정밀 분석 참고',res.fixable?'success':'error',3800);
        }
      }catch(e){this.toast('자동 수정 처방 실패','error');}
      finally{this.fixing=false;}
    },
    jumpToPreCell(nid,iso){
      if(iso){const p=String(iso).split('-').map(Number);if(p[0]&&p[1]){this.year=p[0];this.month=p[1];}}
      this.activeTab='preinput';
      this.$nextTick(()=>setTimeout(()=>{
        let el=(nid&&iso)?document.querySelector(`[data-cell="${nid}|${iso}"]`):null;
        if(!el&&iso)el=document.querySelector(`[data-cell$="|${iso}"]`);
        // 날짜 없는 앵커(연속야간·V한도 등 간호사 단위)는 해당 행 첫 셀로 폴백
        if(!el&&nid)el=document.querySelector(`[data-cell^="${nid}|"]`);
        if(el){el.scrollIntoView({behavior:'smooth',block:'center',inline:'center'});el.classList.add('g-jump-flash');setTimeout(()=>el.classList.remove('g-jump-flash'),2400);}
        else this.toast('해당 셀이 현재 주기 화면에 없습니다','info',3000);
      },140));
    },
    applyFix(){
      const r=this.fixResult; if(!r)return;
      const rms=r.removals||[]; const sfs=(r.shortfalls||[]).filter(s=>s.kind==='staff');
      if(!rms.length&&!sfs.length){this.toast('적용할 수정이 없습니다','info');return;}
      // 휴무(OFF·연차류 = 간호사 개인의 시간) 제거가 포함되면 명시적 확인 — 무심코 적용 금지
      const timeoffRms=rms.filter(rm=>rm.is_timeoff);
      if(timeoffRms.length){
        const detail=timeoffRms.slice(0,8).map(rm=>`• ${rm.nurse} ${rm.date} '${rm.pre}'`).join('\n');
        const more=timeoffRms.length>8?`\n… 외 ${timeoffRms.length-8}건`:'';
        if(!confirm(`⚠ 이 처방은 간호사의 휴무 ${timeoffRms.length}건을 제거합니다.\n휴무(OFF·연차 등)는 간호사 개인의 시간(휴식·여행·성취·결혼 등)입니다 — 가능하면 인원 추가나 수요 감축을 먼저 검토하세요.\n\n${detail}${more}\n\n그래도 휴무를 제거하고 적용하시겠습니까?`)) return;
      }
      this._pushUndo();
      let rn=0;
      for(const rm of rms){
        if(rm.nurse_id&&rm.date_iso&&this.prevSchedule[rm.nurse_id]&&this.prevSchedule[rm.nurse_id][rm.date_iso]!==undefined){
          delete this.prevSchedule[rm.nurse_id][rm.date_iso]; rn++;
          if(!Object.keys(this.prevSchedule[rm.nurse_id]).length)delete this.prevSchedule[rm.nurse_id];
        }
      }
      let sn=0;
      for(const s of sfs){
        const d=new Date(s.date+'T00:00:00'); if(isNaN(d))continue;
        const cur=this.getPrevDayReq(d,s.code); const base=this.getDefaultDayReq(d,s.code);
        const curVal=(cur!==null&&cur!==undefined)?cur:base;
        this.setPrevDayReq(d,s.code,Math.max(0,curVal-(s.amount||0))); sn++;
      }
      if(this._checkViolations)this._checkViolations();
      const _lv=timeoffRms.length?`⚠ 휴무 ${timeoffRms.length}건 포함 · `:'';
      this.toast(`처방 적용 — ${_lv}사전입력 ${rn}건 제거, 수요 ${sn}건 감축 (Ctrl+Z 취소)`,'success',4500);
      this.fixResult=null; this.activeTab='preinput';
    },

  };
};
