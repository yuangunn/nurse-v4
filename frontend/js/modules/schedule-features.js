/* ────────────────────────────────────────────────────────────────────────────
 * 스케줄 기능 — CSV/인쇄 내보내기·스케줄 비교·수동편집 추적·월간 요약·이전달 연동·희망근무 입력·다중 솔버 비교·템플릿·간호사 CSV 입출력
 *
 * 사용: app() 반환 객체에 `...ScheduleFeaturesModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.ScheduleFeaturesModule = function() {
  return {
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
        const payload={year:this.year,month:this.month,nurses:this.nurses,requirements:this.requirements,rules:this.rules,prev_schedule:Object.keys(this.prevSchedule).length?this.prevSchedule:null,locked_cells:Object.keys(this.lockedCells).length?this.lockedCells:null,per_day_requirements:Object.keys(this.prevDayReqs).length?this.prevDayReqs:null,holidays:this.holidays,shifts:this.shifts,prev_month_nights:Object.keys(this.prevMonthNights).length?this.prevMonthNights:null,mip_gap:Math.max(0.02,this.mipGap+i*0.02),time_limit:Math.min(this.generateTimeout*60,120),allow_pre_relax:this.allowPreRelax,allow_juhu_relax:this.allowJuhuRelax,unlimited_v:this.unlimitedV,solver:this.solver};
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

  };
};
