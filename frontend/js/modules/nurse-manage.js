/* ────────────────────────────────────────────────────────────────────────────
 * 간호사 관리 — 로드/추가/수정/삭제·선택·인라인 편집·일괄 작업(그룹/성별/야간/삭제)
 *
 * 사용: app() 반환 객체에 `...NurseManageModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.NurseManageModule = function() {
  return {
    // ── 간호사 ────────────────────────────────────────────────
    async loadNurses(){this.nurses=await this.api('GET','/api/nurses')},
    _monthKey(){return `${this.year}-${String(this.month).padStart(2,'0')}`},
    isNightThisMonth(nurse){const mk=this._monthKey();const nm=nurse.night_months||{};return Object.keys(nm).length>0?!!nm[mk]:nurse.is_night_shift},
    // 야간전담(나이트킵) 뱃지 — '3월 야간전담' / '3,5월 야간전담' 처럼 어느 달인지 보여준다.
    // 당월만 켜고 끄는 표시로는 "이 사람이 언제 나이트킵인지"를 명부에서 알 수 없다.
    nightMonthsBadge(nurse){
      const nm=nurse.night_months||{};
      const keys=Object.keys(nm).filter(k=>nm[k]).sort();
      const on=this.isNightThisMonth(nurse);
      if(!keys.length){
        return nurse.is_night_shift
          ? {text:'상시 야간전담',title:'월별 지정 없음 — 모든 달 야간전담',on:true,any:true}
          : {text:'—',title:'야간전담 아님 (클릭하면 '+this.month+'월 지정)',on:false,any:false};
      }
      const yr=String(this.year);
      const cur=keys.filter(k=>k.slice(0,4)===yr).map(k=>+k.slice(5,7)).sort((a,b)=>a-b);
      const other=keys.filter(k=>k.slice(0,4)!==yr);
      const parts=[];
      if(cur.length){
        // 달이 많으면 요약하되 '이번 달 포함' 여부는 남긴다 (전체 목록은 툴팁)
        if(cur.length>6)parts.push(on?`${this.month}월 외 ${cur.length-1}개월`:`${cur.length}개월`);
        else parts.push(`${cur.join(',')}월`);
      }
      for(const k of other)parts.push(`${k.slice(0,4)}년 ${+k.slice(5,7)}월`);
      const full=keys.map(k=>`${k.slice(0,4)}년 ${+k.slice(5,7)}월`).join(', ');
      return {text:`${parts.join(' · ')} 야간전담`,
              title:`${full} 야간전담 — 클릭하면 ${this.month}월을 켜고 끕니다`,
              on, any:true};
    },
    toggleNightMonthModal(m,checked){const mk=`${this.year}-${String(m).padStart(2,'0')}`;if(!this.nurseModal.data.night_months)this.nurseModal.data.night_months={};if(checked)this.nurseModal.data.night_months[mk]=true;else delete this.nurseModal.data.night_months[mk]},
    openNurseModal(nurse){
      this.nurseModal.isNew=!nurse;
      this.nurseModal.data=nurse?JSON.parse(JSON.stringify(nurse)):{id:crypto.randomUUID(),name:'',group:'',gender:'female',capable_shifts:['DC','D','EC','E','NC','N'],is_night_shift:false,night_months:{},seniority:this.nurses.length,wishes:{},juhu_day:null,juhu_auto_rotate:true,is_trainee:false,training_end_date:null,preceptor_id:null,start_date:null,end_date:null,is_pregnant:false,pregnancy:{}};
      // 임산부 구간 구조 정규화 (x-model 바인딩 안전 — 기존 간호사 호환)
      const d=this.nurseModal.data;
      if(d.is_pregnant===undefined)d.is_pregnant=false;
      if(!d.pregnancy||typeof d.pregnancy!=='object')d.pregnancy={};
      if(!d.pregnancy.early)d.pregnancy.early={start:null,end:null};
      if(!d.pregnancy.late)d.pregnancy.late={start:null,end:null};
      this.nurseModal.open=true;
    },
    toggleShift(s){const arr=this.nurseModal.data.capable_shifts;const idx=arr.indexOf(s);if(idx>=0)arr.splice(idx,1);else arr.push(s)},
    async saveNurse(){if(!this.nurseModal.data.name.trim()){this.toast('이름을 입력하세요','error');return}await this.api('POST','/api/nurses',this.nurseModal.data);await this.loadNurses();this.nurseModal.open=false},
    async removeNurse(id){
      // 인라인 확인: 첫 클릭은 표시만, 두 번째 클릭에서 실제 삭제
      if(this._removeConfirmId!==id){
        this._removeConfirmId=id;
        clearTimeout(this._removeConfirmTimer);
        this._removeConfirmTimer=setTimeout(()=>{this._removeConfirmId=null},2500);
        return;
      }
      clearTimeout(this._removeConfirmTimer);
      this._removeConfirmId=null;
      await this.api('DELETE',`/api/nurses/${id}`);
      await this.loadNurses();
      delete this.selectedNurseMap[id];
    },
    _removeConfirmId:null,
    _removeConfirmTimer:null,

    // ── 인라인 편집 / 일괄 작업 ──────────────────────────────
    isNurseSelected(id){return !!this.selectedNurseMap[id]},
    toggleNurseSelect(id){
      if(this.selectedNurseMap[id])delete this.selectedNurseMap[id];
      else this.selectedNurseMap[id]=true;
    },
    toggleAllNurseSelect(){
      if(this.allNursesSelected)this.selectedNurseMap={};
      else{const m={};for(const n of this.nurses)m[n.id]=true;this.selectedNurseMap=m}
    },
    clearNurseSelection(){this.selectedNurseMap={}},

    async _saveNurseInline(nurse,patch){
      // 낙관적 갱신 + 서버 저장
      const prev={};for(const k of Object.keys(patch))prev[k]=nurse[k];
      Object.assign(nurse,patch);
      try{
        await this.api('POST','/api/nurses',nurse);
      }catch(e){
        Object.assign(nurse,prev);  // 롤백
        this.toast(e.message||'저장 실패','error');
      }
    },
    async inlineRename(nurse,newName){
      newName=(newName||'').trim();
      if(!newName){this.toast('이름은 비울 수 없음','warn');return}
      if(newName===nurse.name)return;
      await this._saveNurseInline(nurse,{name:newName});
    },
    async inlineSetGroup(nurse,newGroup){
      newGroup=(newGroup||'').trim().slice(0,3);
      if(newGroup===nurse.group)return;
      await this._saveNurseInline(nurse,{group:newGroup});
      this._rememberGroup(newGroup);
    },
    async inlineToggleGender(nurse){
      await this._saveNurseInline(nurse,{gender:nurse.gender==='female'?'male':'female'});
    },
    async inlineToggleShift(nurse,shift){
      const arr=[...(nurse.capable_shifts||[])];
      const i=arr.indexOf(shift);
      if(i>=0)arr.splice(i,1);else arr.push(shift);
      await this._saveNurseInline(nurse,{capable_shifts:arr});
    },
    async inlineToggleNightThisMonth(nurse){
      const mk=this._monthKey();
      const nm={...(nurse.night_months||{})};
      if(nm[mk])delete nm[mk];else nm[mk]=true;
      await this._saveNurseInline(nurse,{night_months:nm});
    },

    _bulkGroupInput:'',
    async bulkSetGroup(groupOverride){
      const grp=((groupOverride!==undefined?groupOverride:this._bulkGroupInput)||'').trim().slice(0,3);
      const ids=this.selectedNurseIds;
      if(!ids.length)return;
      const loadingId=this.toast(`${ids.length}명 그룹 변경 중...`,'loading');
      try{
        for(const id of ids){
          const n=this.nurses.find(x=>x.id===id);
          if(n)await this._saveNurseInline(n,{group:grp});
        }
        if(grp)this._rememberGroup(grp);
        this.dismissToast(loadingId);
        this.toast(`${ids.length}명 그룹을 '${grp||"(없음)"}'으로 변경`,'info');
        this._bulkGroupInput='';
        this.clearNurseSelection();
      }catch(e){
        this.dismissToast(loadingId);
        this.toast(e.message||'일괄 변경 실패','error');
      }
    },
    async bulkSetGender(g){
      const ids=this.selectedNurseIds;
      if(!ids.length)return;
      for(const id of ids){
        const n=this.nurses.find(x=>x.id===id);
        if(n)await this._saveNurseInline(n,{gender:g});
      }
      this.toast(`${ids.length}명 성별 ${g==='female'?'여성':'남성'}`,'info');
      this.clearNurseSelection();
    },
    async bulkSetNightThisMonth(on){
      const mk=this._monthKey();
      const ids=this.selectedNurseIds;
      if(!ids.length)return;
      for(const id of ids){
        const n=this.nurses.find(x=>x.id===id);
        if(!n)continue;
        const nm={...(n.night_months||{})};
        if(on)nm[mk]=true;else delete nm[mk];
        await this._saveNurseInline(n,{night_months:nm});
      }
      this.toast(`${ids.length}명 ${this.month}월 야간전담 ${on?'설정':'해제'}`,'info');
      this.clearNurseSelection();
    },
    _bulkDeleteConfirm:false,
    _bulkDeleteTimer:null,
    async bulkDelete(){
      const ids=this.selectedNurseIds;
      if(!ids.length)return;
      if(!this._bulkDeleteConfirm){
        this._bulkDeleteConfirm=true;
        clearTimeout(this._bulkDeleteTimer);
        this._bulkDeleteTimer=setTimeout(()=>{this._bulkDeleteConfirm=false},3000);
        return;
      }
      clearTimeout(this._bulkDeleteTimer);
      this._bulkDeleteConfirm=false;
      const loadingId=this.toast(`${ids.length}명 삭제 중...`,'loading');
      try{
        for(const id of ids){
          await this.api('DELETE',`/api/nurses/${id}`);
        }
        await this.loadNurses();
        this.dismissToast(loadingId);
        this.toast(`${ids.length}명 삭제 완료`,'info');
        this.clearNurseSelection();
      }catch(e){
        this.dismissToast(loadingId);
        this.toast(e.message||'삭제 실패','error');
      }
    },

  };
};
