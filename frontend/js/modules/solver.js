/* ────────────────────────────────────────────────────────────────────────────
 * 스케줄 생성 + 정밀 충돌 분석 — generate/stopGenerate·diagnoseConflicts·suggestFix·applyFix·jumpToPreCell
 *
 * 사용: app() 반환 객체에 `...SolverModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.SolverModule = function() {
  return {
    // 계산 기록 두 곳 — 만드는 중 상태 줄 아래(#liveLogPanel)·서랍(#logPanel) — 을 맨 아래 줄로 (새로고침 복구 app.js 도 쓴다)
    _scrollLogs(){ this.$nextTick(()=>{ for(const el of document.querySelectorAll('#logPanel,#liveLogPanel')) el.scrollTop=el.scrollHeight; }); },
    // ── 스케줄 생성 ──────────────────────────────────────────
    // patch: 재조정 등에서 payload 일부를 덮어쓸 때 사용 (_readjust·_cont 플래그는 전송 전 제거)
    // _cont: 이어 찾기(결정 1-50) — 앞 표·안내를 그대로 둔 채 그 표에서 다시 찾고, 더 좋은 표가 나올 때만 바꾼다
    async generate(patch){
      if(this.nurses.length===0){this.toast('간호사를 먼저 등록해주세요','error');return}
      const {_readjust,_cont,...payloadPatch}=patch||{};
      if(this._recoverPoll){clearInterval(this._recoverPoll);this._recoverPoll=null}
      this.generating=true;this.continuing=!!_cont;this.stopRequested=false;
      if(!_cont){this.mipGapPercent=null;this.scheduleStopped=false;this.rdSaved=false;this.diagResult=null;this.fixResult=null;this.statusMessage=''}
      this.estimatedSeconds=0;this.generateStartTime=Date.now();this.generateElapsed=0;
      let next=null;
      this.generateTimer=setInterval(()=>{this.generateElapsed=Math.floor((Date.now()-this.generateStartTime)/1000)},1000);
      this.solveProgress={gap_percent:null,nodes:0,has_solution:false,is_running:false};
      this.solverLogs=[];this._logSeq=0;
      this.sseSource=new EventSource('/api/generate/stream');
      this.sseSource.onmessage=(e)=>{
        const data=JSON.parse(e.data);
        if(data.type==='log'){this.solverLogs.push({id:++this._logSeq,msg:data.msg});if(this.solverLogs.length>300)this.solverLogs=this.solverLogs.slice(-200);this._scrollLogs()}
        else if(data.type==='hint'){this.solverLogs.push({id:++this._logSeq,msg:data.msg,hint:true});this._scrollLogs()}
        else if(data.type==='progress')this.solveProgress=data;
        else if(data.type==='done'){this.sseSource.close();this.sseSource=null}
      };
      const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,locked_cells:Object.keys(this.lockedCells).length?this.lockedCells:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:this.mipGap,time_limit:this.generateTimeout*60,allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,juhu_block_lock:this.juhuBlockLock,unlimited_v:this.unlimitedV,solver:this.solver,...payloadPatch};
      this.api('POST','/api/estimate',payload).then(est=>{if(est&&est.estimated_seconds)this.estimatedSeconds=est.estimated_seconds}).catch(()=>{});
      try{
        const result=await this.api('POST','/api/generate',payload);
        // 이어 찾는 동안 손으로 고친 칸이 있으면 그 표를 그대로 둔다 — 바꾸면 고친 칸이 말없이 사라졌다 (리뷰 2026-10-19)
        const edited=_cont&&(this._originalSchedule?this.getManualEditCount():0)>0;
        if(_cont&&(edited||!this._contBetter(result))){this._contKeep(result,_cont,edited);return}
        this.statusOk=result.success;this.statusMessage=result.message;
        this.generationReport=result.generation_report||null;
        this.wishReport=result.wish_report||null;
        this.offTeukgeun=result.off_teukgeun||[];this.managerCheck=result.manager_check||[];this.vReport=result.v_report||null;
        this.relaxBoosts=result.relax_boosts||{};
        this.fairnessOffsets=result.fairness_offsets||null;this.weekendOffsets=result.weekend_offsets||null;
        this.loadFairnessLedger&&this.loadFairnessLedger();
        // 13단계 진단이 짚은 셀 좌표 → 정밀분석과 동일한 '충돌 위치로 이동' 칩 표시
        if(!result.success&&((Array.isArray(result.anchored)&&result.anchored.length)||result.summary)){this.diagResult={anchored:result.anchored||[],summary:result.summary||''}}
        if(result.success){this.schedule=result.schedule;this.extendedSchedule=result.extended_schedule;this.nurseScores=result.nurse_scores||{};this.nurseScoreDetails=result.nurse_score_details||{};this.mipGapPercent=result.mip_gap_percent!==undefined?result.mip_gap_percent:null;this.scheduleStopped=result.stopped===true;this.relaxedCells=result.relaxed_cells||{};this.showReports=!!(Object.keys(this.relaxedCells).length||(this.offTeukgeun||[]).length||(this.managerCheck||[]).length||(this.vReport&&this.vReport.total));this.reportTab=Object.keys(this.relaxedCells).length?'relaxed':((this.managerCheck||[]).length?'warn':(this.vReport&&this.vReport.total?'v':'summary'));this.rdDoneAt=new Date();this.activeTab='schedule';this._autoSaveSchedule();   // 생성 성공 시 자동 저장 (같은 달 자동저장본 하나만)
          if(result.stopped)this.statusMessage+='\n⏹ 중지 요청으로 탐색 종료 — 현재까지 찾은 최선의 해를 표시합니다.';
          // 완화된 셀 상세 메시지
          if(Object.keys(this.relaxedCells).length>0){
            // 원티드(사전입력)에는 사연이 있다 — 뒤집힌 셀은 메모(사유)와 함께, 메모 있는 셀을 먼저
            const details=[];let noted=0;
            for(const[nid,cells]of Object.entries(this.relaxedCells)){
              const nurse=this.nurses.find(n=>n.id===nid);
              const name=nurse?nurse.name:nid;
              for(const[dk,info]of Object.entries(cells)){
                const dateStr=dk.slice(5).replace('-','/');
                const note=this.cellNotes?.[nid]?.[dk]||'';
                if(note)noted++;
                details.push({note,line:`  ${name} ${dateStr}: ${info.original} → ${info.assigned}${note?'  📝 '+note:''}`});
              }
            }
            details.sort((a,b)=>(b.note?1:0)-(a.note?1:0));
            this.statusMessage+=`\n\n📌 원티드 미반영 ${details.length}건${noted?` — 그중 메모(사유) 있는 셀 ${noted}건`:''}. 절대 못 바꾸는 날은 사전입력에서 🔒 잠금하세요.\n`+details.map(d=>d.line).join('\n');
          }
          this.trackEdits();
          if(!_readjust){this.readjustPins={};this.readjustChanged={};this.readjustSummary=''}
          if(result.warning){this.statusMessage=result.warning+'\n\n'+this.statusMessage;this.statusOk=false}
          if(_cont)this.statusMessage+=`\n\n🔁 이어 찾기로 더 좋은 표를 찾아 바꿔 저장했습니다${_cont.gap!=null&&this.mipGapPercent!=null?` (가장 좋은 답과 ${_cont.gap}% → ${this.mipGapPercent}% 차이)`:''}.`;
          else if(!_readjust&&!this.stopRequested&&this._wantsContinue(result)){
            this.statusMessage+=`\n\n🔁 가장 좋은 답과 ${result.mip_gap_percent}% 차이라 목표(${Math.round(this.mipGap*1000)/10}%)보다 큽니다 — 지금 표를 저장해 두고 이 표에서 한 번 더 찾습니다. 멈추면 지금 표를 씁니다.`;
            // 첫 요청을 그대로 다시 — 그동안 달·설정을 바꿨어도 같은 문제를 잇는다. 레이스면 이긴 엔진으로 (엔진마다 목적식이 달라 견줄 수 없다)
            const solver=payload.solver==='race'&&result.engine?(result.engine==='CP-SAT'?'cpsat':'highs'):payload.solver;
            next={...payload,solver,warm_start:result.extended_schedule||result.schedule,prev_bound:result.mip_dual_bound??null,
              prev_fingerprint:result.model_fingerprint||null,prev_objective:result.objective??null,
              _cont:{objective:result.objective??null,fingerprint:result.model_fingerprint||null,gap:result.mip_gap_percent,message:this.statusMessage,ok:this.statusOk}};
          }}
      }catch(e){if(_cont)this._contKeep(null,_cont);else{this.statusOk=false;this.statusMessage='서버 오류: '+e.message}}
      finally{this.generating=false;this.continuing=false;this.stopRequested=false;if(this.generateTimer){clearInterval(this.generateTimer);this.generateTimer=null}if(this.sseSource){this.sseSource.close();this.sseSource=null}this.generateFinalElapsed=this.generateElapsed;
        if(next)setTimeout(()=>this.generate(next),0)}
    },
    // ── 이어 찾기 (결정 1-50) — 시간이 다 됐는데 차이가 목표(설정 mipGap)보다 크면 그 표에서 한 번 더 찾는다 ──
    // 실제 11월: 20분 8.8% → 같은 탐색을 60분까지 이으면 3.4%, 20분 표에서 다시 찾으면 41분에 1.9% (다시 찾는 쪽이 나았다)
    _wantsContinue(r){
      return !!r&&r.success&&!r.stopped&&!r.pinned_confirmed&&r.mip_gap_percent!=null&&r.mip_gap_percent>this.mipGap*100+1e-9;
    },
    // 더 좋은 표인가 — 서버가 같은 모델(지문)에서 감점이 낮은지 가려 단 improved (새로고침 복구도 같은 표시를 쓴다)
    _contBetter(r){
      return !!(r&&r.success&&r.improved);
    },
    // 앞 표를 그대로 둔다 — 같은 모델의 하한이 더 올랐으면 앞 표의 차이를 그만큼 줄여 보여 준다
    _contKeep(r,c,edited){
      this.statusOk=c.ok;
      let g=c.gap;
      if(r&&r.success&&c.objective!=null&&r.mip_dual_bound!=null&&r.model_fingerprint&&r.model_fingerprint===c.fingerprint){
        g=Math.round(Math.max(0,c.objective-r.mip_dual_bound)/Math.max(1,Math.abs(c.objective))*10000)/100;
      }
      this.mipGapPercent=g;
      this.statusMessage=c.message+(edited
        ? `\n\n🔁 이어 찾는 동안 손으로 고친 칸이 있어 고친 표를 그대로 둡니다${r&&r.improved?' (이어 찾기에서 나온 표는 쓰지 않았습니다)':''}.`
        : r&&r.success
        ? `\n\n🔁 이어 찾기에서 더 좋은 표는 없었습니다 — 지금 표 그대로${g!=null?` (가장 좋은 답과 ${g}% 안쪽)`:''}.`
        : `\n\n🔁 이어 찾기를 끝내지 못해 지금 표를 그대로 둡니다.`);
    },
    // 완화 카드 제목 — "원티드 미반영 N건 (메모 있는 셀 M건)"
    relaxedSummaryLabel(){
      let n=0,m=0;
      for(const[nid,cells]of Object.entries(this.relaxedCells||{})){
        for(const dk of Object.keys(cells)){n++;if(this.cellNotes?.[nid]?.[dk])m++}
      }
      return `📌 원티드 미반영 ${n}건`+(m?` (메모 있는 셀 ${m}건)`:'');
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
      this.rdUndoToast&&this.rdUndoToast(`수정안을 적용했습니다 — 사전입력 ${rn}칸을 빼고 필요 인원 ${sn}건을 줄였어요.`);
      this.fixResult=null; this.activeTab='preinput';
    },

  };
};
