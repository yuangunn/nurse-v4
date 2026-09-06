/* ────────────────────────────────────────────────────────────────────────────
 * 스케줄 기능 — CSV/인쇄 내보내기·스케줄 비교·수동편집 추적·월간 요약·이전달 연동·희망근무 입력·다중 솔버 비교·템플릿·간호사 CSV 입출력
 *
 * 사용: app() 반환 객체에 `...ScheduleFeaturesModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.ScheduleFeaturesModule = function() {
  return {
    // ═══ 0. 사람이 짠 근무표를 그대로 근무표로 확정 ═════════
    // 이미 손으로 완성한 표를 넣고 싶을 때 솔버를 돌릴 이유가 없다.
    // 사전입력에 붙여넣은 표를 그대로 스케줄로 옮긴다 (검증 없음 — 사람이 짠 게 정답).
    usePrevAsSchedule(){
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      let filled=0, holes=[];
      for(const n of this.nurses){
        for(const d of days){
          if(this.prevSchedule[n.id]?.[this.dayKey(d)]) filled++;
          else holes.push(`${n.name} ${d.getMonth()+1}/${d.getDate()}`);
        }
      }
      if(!filled){ this.toast('사전입력이 비어 있습니다','error'); return }
      const msg=holes.length
        ? `빈 칸이 ${holes.length}개 있습니다 (예: ${holes.slice(0,3).join(', ')}).\n`
          +`빈 칸은 비워 둔 채로 넘어갑니다.\n\n${filled}건을 근무표로 확정할까요?`
        : `${filled}건을 근무표로 확정합니다. 솔버는 돌리지 않습니다.\n계속할까요?`;
      if(!confirm(msg)) return;
      this.schedule=JSON.parse(JSON.stringify(this.prevSchedule));
      this.extendedSchedule=null; this.nurseScores={}; this.nurseScoreDetails={};
      this.relaxedCells={}; this.scheduleStopped=false; this.mipGapPercent=null;
      this.solverLog=[]; this.generateResult=null;
      this.activeTab='schedule';
      this.rdDoneAt=new Date(); this._autoSaveSchedule();   // 확정도 생성과 같이 자동 저장
      this.toast(`근무표로 확정했습니다 (${filled}건) — 점수는 솔버를 돌려야 나옵니다`,'info');
    },

    // 어싸인(standalone)에 붙여넣을 수 있는 표로 복사 — 이름 + 날짜 + 근무
    copyScheduleTsv(){
      if(!this.schedule||!Object.keys(this.schedule).length){ this.toast('근무표가 없습니다','error'); return }
      const days=this.scheduleDays.filter(d=>!this.isOverflow(d));
      const lines=[['이름',...days.map(d=>`${d.getMonth()+1}/${d.getDate()}`)].join('\t')];
      for(const n of this.nurses)
        lines.push([n.name,...days.map(d=>this.schedule[n.id]?.[this.dayKey(d)]||'')].join('\t'));
      navigator.clipboard.writeText(lines.join('\n'))
        .then(()=>this.toast('복사했습니다 — 어싸인 배정표에 붙여넣으세요','info'))
        .catch(()=>this.toast('복사 실패','error'));
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

    // ═══ 4b. 핀포인트 수정 반영 재조정 ═══════════════════════
    // 고친 칸은 잠그고 나머지 전체를 사전입력(유지 보너스)으로 되먹여 재생성 —
    // 하드 제약을 다시 맞추는 데 필요한 최소한의 칸만 따라 움직인다.
    readjustPins:{}, readjustChanged:{}, readjustSummary:'',
    getEditedCells(){
      if(!this._originalSchedule)return {};
      const out={};
      const nids=new Set([...Object.keys(this.schedule||{}),...Object.keys(this._originalSchedule||{})]);
      for(const nid of nids){
        const cur=this.schedule[nid]||{}, org=this._originalSchedule[nid]||{};
        for(const dk of new Set([...Object.keys(cur),...Object.keys(org)])){
          if((cur[dk]||'')!==(org[dk]||''))(out[nid]=out[nid]||{})[dk]=true;
        }
      }
      return out;
    },
    // 근무표에서 일별 D/E/N 인원 역산 — 재조정 시 이 표의 인원수가 기준 (설정 기본값 무시)
    _reqFromSchedule(sched){
      const P={DC:'D',D:'D',EC:'E',E:'E',NC:'N',N:'N'};
      const out={};
      for(const days of Object.values(sched||{}))
        for(const[dk,code]of Object.entries(days||{})){
          const p=P[code]; if(!p)continue;
          (out[dk]=out[dk]||{D:0,E:0,N:0})[p]++;
        }
      return out;
    },
    isReadjustPin(nurseId,day){return !!this.readjustPins[nurseId]?.[this.dayKey(day)]},
    isReadjustChanged(nurseId,day){return !!this.readjustChanged[nurseId]?.[this.dayKey(day)]},
    async readjustSchedule(){
      if(this.generating)return;
      const pins=this.getEditedCells();
      const nPin=Object.values(pins).reduce((a,m)=>a+Object.keys(m).length,0);
      if(!nPin){this.toast('수정한 칸이 없습니다 — 근무표 셀을 먼저 고쳐주세요','info');return}
      // 수정 전 표의 인원수 유지가 기준. 지운 칸은 잠그면 '하루 1근무'와 충돌 — 솔버가 채우게 둔다
      const dayReq=this._reqFromSchedule(this._originalSchedule);
      const locked=JSON.parse(JSON.stringify(this.lockedCells||{}));
      const prevPayload={};
      for(const[nid,days]of Object.entries(this.schedule)){
        for(const[dk,v]of Object.entries(days||{})){
          if(!v||v==='__CLEAR__')continue;
          (prevPayload[nid]=prevPayload[nid]||{})[dk]=v;
          if(pins[nid]?.[dk])(locked[nid]=locked[nid]||{})[dk]=true;
        }
      }
      const before=JSON.parse(JSON.stringify(this.schedule));
      await this.generate({
        prev_schedule:prevPayload,
        locked_cells:locked,
        per_day_requirements:dayReq,
        time_limit:Math.min(this.generateTimeout*60,300),
        // 수정으로 그날 인원이 어긋난 사전입력은 완화로만 풀린다 —
        // 잠근 칸(locked)은 완화 모드에서도 고정이므로 사용자 수정은 안전
        allow_pre_relax:true,
        _readjust:true,
      });
      if(!this.statusOk)return;          // 실패 시 수정본 유지 + 기존 진단 표시
      const changed={}; const detail=[];
      const nids=new Set([...Object.keys(this.schedule||{}),...Object.keys(before)]);
      let nChg=0;
      for(const nid of nids){
        const cur=this.schedule[nid]||{}, prev=before[nid]||{};
        for(const dk of new Set([...Object.keys(cur),...Object.keys(prev)])){
          if((cur[dk]||'')===(prev[dk]||'')||pins[nid]?.[dk])continue;
          (changed[nid]=changed[nid]||{})[dk]=true; nChg++;
          const nurse=this.nurses.find(n=>n.id===nid);
          detail.push(`  ${nurse?nurse.name:nid} ${dk.slice(5).replace('-','/')}: ${prev[dk]||'(빈칸)'} → ${cur[dk]||'(빈칸)'}`);
        }
      }
      this.readjustPins=pins; this.readjustChanged=changed;
      this.readjustSummary=`📌 고정 ${nPin}칸 · 따라 고침 ${nChg}칸`;
      this.statusMessage=`✅ 재조정 완료 — 고친 ${nPin}칸은 그대로, 솔버가 ${nChg}칸을 따라 고쳤습니다.`+
        (nChg?'\n\n📋 따라 고친 칸:\n'+detail.slice(0,20).join('\n')+(detail.length>20?`\n  … 외 ${detail.length-20}건`:''):'')+
        '\n\n'+this.statusMessage;
      this.toast(`재조정 완료 — 고정 ${nPin}칸, 따라 고침 ${nChg}칸`,'success',4000);
    },

    // ═══ 5. 간호사별 월간 요약 ═══════════════════════════
    showNurseSummary:false,

    // ═══ 6. 이전달 스케줄 자동 연동 ══════════════════════
    async loadPrevMonthSchedule(){
      const py=this.month===1?this.year-1:this.year;
      const pm=this.month===1?12:this.month-1;
      const list=await this.api('GET','/api/schedules');
      const prev=list.find(s=>s.year===py&&s.month===pm);
      if(!prev){this.toast(`${py}년 ${pm}월 저장된 근무표가 없습니다`,'error');return}
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
    getWish(nurseId,day){
      if(!nurseId||!day)return'';
      const n=this.nurses.find(x=>x.id===nurseId);
      return n?.wishes?.[this.dayKey(day)]||'';
    },
    setWishAndSave(nurseId,day,shift){
      // 셀 단위 위시 입력 + 간호사 레코드 영속화 (위시는 nurse.wishes에 저장됨)
      this.setWish(nurseId,day,shift);
      const n=this.nurses.find(x=>x.id===nurseId);
      if(n)this.api('POST','/api/nurses',n).catch(()=>this.toast('희망 서버 저장 실패','error'));
    },

    // ═══ 9. 다중 솔버 비교 ═══════════════════════════════
    multiSolveResults:[],
    async generateMultiple(count=2){
      this.multiSolveResults=[];
      for(let i=0;i<count;i++){
        const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,locked_cells:Object.keys(this.lockedCells).length?this.lockedCells:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:Math.max(0.02,this.mipGap+i*0.02),time_limit:Math.min(this.generateTimeout*60,120),allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,juhu_block_lock:this.juhuBlockLock,unlimited_v:this.unlimitedV,solver:this.solver};
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
      const name=this._safePrompt('템플릿 이름을 입력하세요','기본 템플릿');if(!name)return;
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

    // ═══ 간호사 명부 템플릿 다운로드/업로드 (xlsx 기본, CSV도 가져오기 허용) ═══
    async downloadNurseTemplate(){
      try{
        // 드롭다운·안내 시트가 든 엑셀 템플릿 — "CSV로 저장" 단계가 필요 없다
        const res=await fetch('/api/nurses/template.xlsx');
        if(!res.ok)throw new Error('템플릿 다운로드 실패');
        const blob=await res.blob();
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;a.download='nurses_template.xlsx';
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);URL.revokeObjectURL(url);
        this.toast('엑셀 템플릿 다운로드 완료 — 채워서 그대로 가져오기 하세요','info',4000);
      }catch(e){this.toast(e.message||'다운로드 실패','error')}
    },

    async exportNursesToCSV(){
      if(!this.nurses.length){this.toast('내보낼 간호사가 없습니다','warn');return}
      try{
        const res=await fetch('/api/nurses/export.xlsx');
        if(!res.ok)throw new Error('내보내기 실패');
        const blob=await res.blob();
        const url=URL.createObjectURL(blob);
        const ymd=new Date().toISOString().slice(0,10);
        const a=document.createElement('a');
        a.href=url;a.download=`nurses_${ymd}.xlsx`;
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);URL.revokeObjectURL(url);
        this.toast(`${this.nurses.length}명 엑셀 내보내기 완료`,'info');
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
      if(!/\.(xlsx|xlsm|csv|txt)$/i.test(file.name)){
        this.toast('엑셀(xlsx) 또는 CSV/TXT 파일만 가능합니다','warn');
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

  };
};
