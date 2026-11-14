/* ────────────────────────────────────────────────────────────────────────────
 * 간호사 관리 — 로드/추가/수정/삭제·선택·인라인 편집·일괄 작업(팀/성별/야간/삭제)·그룹(여러 그룹에 겹쳐 속함)
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
    // Shift 기준·'한 번 더 누르면 지웁니다' 대기까지 — 병동 전환도 이걸 부른다 (새 병동도 같은 시드 id 라 고르지 않은 줄이 골라져 있었다)
    clearNurseSelection(){this.selectedNurseMap={};this._rosterAnchor=null;this._bulkDeleteConfirm=false;clearTimeout(this._bulkDeleteTimer)},
    // 체크 칸을 누른 채 끌면 지나간 줄을 모두 첫 줄과 같은 상태로 (켜며 끌면 켜고, 끄며 끌면 끈다).
    // Shift+누르기 = 앞서 누른 줄부터 여기까지 켜기. 놓기는 app.js 의 mouseup.
    _rosterPaint:null,
    _rosterAnchor:null,
    rosterSelDown(idx,e){
      if(e.button!==0)return;
      e.preventDefault();                              // 끄는 동안 글자가 잡히지 않게
      const id=this.nurses[idx].id,a=this.nurses.findIndex(n=>n.id===this._rosterAnchor);
      const range=e.shiftKey&&a>=0;
      this._rosterPaint={from:range?a:idx,on:range||!this.selectedNurseMap[id],base:{...this.selectedNurseMap}};
      if(!range)this._rosterAnchor=id;
      this.rosterSelOver(idx);
    },
    rosterSelOver(idx){
      const p=this._rosterPaint;if(!p)return;
      const m={...p.base};
      for(let i=Math.min(p.from,idx);i<=Math.max(p.from,idx);i++){const id=this.nurses[i].id;if(p.on)m[id]=true;else delete m[id]}
      this.selectedNurseMap=m;
    },

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
      const loadingId=this.toast(`${ids.length}명 팀 변경 중...`,'loading');
      try{
        for(const id of ids){
          const n=this.nurses.find(x=>x.id===id);
          if(n)await this._saveNurseInline(n,{group:grp});
        }
        if(grp)this._rememberGroup(grp);
        this.dismissToast(loadingId);
        this.toast(`${ids.length}명 팀을 '${grp||"(없음)"}'으로 변경`,'info');
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
    // 할 수 있는 근무 — 고른 사람이 모두 켜져 있으면 모두 끄고, 아니면 모두 켠다.
    // 고른 상태는 그대로 둬 여러 칩을 이어 누를 수 있다.
    bulkShiftState(s){
      const ns=this.nurses.filter(n=>this.selectedNurseMap[n.id]);
      const k=ns.filter(n=>(n.capable_shifts||[]).includes(s)).length;
      return k===ns.length?'':k?'some':'off';
    },
    async bulkToggleShift(s){
      const ns=this.nurses.filter(n=>this.selectedNurseMap[n.id]);
      if(!ns.length)return;
      const on=this.bulkShiftState(s)!=='';
      for(const n of ns){
        const cs=n.capable_shifts||[];
        if(cs.includes(s)!==on)await this._saveNurseInline(n,{capable_shifts:on?[...cs,s]:cs.filter(x=>x!==s)});
      }
      this.toast(`${ns.length}명 ${s} ${on?'켬':'끔'}`,'info');
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

    // ── 그룹 (2026-11-12) ─────────────────────────────────────
    // 팀(nurse.group, 한 사람 하나 — 이름 옆 표시·근무표 구분선·주휴 분산)과 따로, 한 사람이 여러 그룹에 속한다.
    // rules.nurseGroups=[{id,name,members:[id],maxPerShift,minPerShift}] — 엔진은 한 근무(D·D1 / E·중 / N)에
    // 그룹원 n명까지(1 = 같이 일하지 않기)·n명 이상을 감점으로 건다 (server _nurse_group_limits).
    groupModal:{open:false,isNew:true,data:{}},
    _groupPaint:null,
    groupDropId:null,
    get nurseGroupList(){return (this.rules&&this.rules.nurseGroups)||[]},
    // 명부에 있는 그룹원만, 명부 순서로 (지운 간호사 id 는 남아 있어도 안 보인다 — 엔진도 모르는 id 는 버린다)
    groupMembersOf(g){const m=new Set(g.members||[]);return this.nurses.filter(n=>m.has(n.id))},
    groupsOfNurse(nid){return this.nurseGroupList.filter(g=>(g.members||[]).includes(nid))},
    _groupBound(v,lo){const n=parseInt(v,10);return Number.isFinite(n)&&n>=lo?n:null},
    groupRuleText(g){
      const mx=this._groupBound(g.maxPerShift,0),mn=this._groupBound(g.minPerShift,1),t=[];
      if(mx!==null)t.push(mx===1?'같이 일하지 않기':`한 근무 ${mx}명까지`);
      if(mn!==null)t.push(`한 근무 ${mn}명 이상`);
      return t.join(' · ');
    },
    async _saveGroups(list,msg){
      const prev=this.nurseGroupList;
      this.rules.nurseGroups=list;
      try{await this.api('POST','/api/rules',{nurseGroups:list});if(msg)this.toast(msg,'info')}
      catch(e){this.rules.nurseGroups=prev;this.toast(e.message||'그룹을 저장하지 못했습니다','error')}
    },
    openGroupModal(g){
      const mx=g?this._groupBound(g.maxPerShift,0):null,mn=g?this._groupBound(g.minPerShift,1):null;
      this.groupModal={open:true,isNew:!g,data:{id:g?g.id:'g'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name:g?g.name:'',
        members:g?this.groupMembersOf(g).map(n=>n.id):[...this.selectedNurseIds],
        same:mx===null?'none':mx===1?'alone':'max',maxN:mx!==null&&mx>1?mx:2,minOn:mn!==null,minN:mn||1}};
    },
    // 명단 칩 — 누르면 넣고 빼고, 누른 채 끌면 지나간 사람을 같은 쪽으로 (놓기는 창 mouseup)
    groupPaintDown(id){const m=this.groupModal.data.members;this._groupPaint=!m.includes(id);this.groupPaintOver(id)},
    groupPaintOver(id){
      if(this._groupPaint===null)return;
      const m=this.groupModal.data.members,i=m.indexOf(id);
      if(this._groupPaint&&i<0)m.push(id);else if(!this._groupPaint&&i>=0)m.splice(i,1);
    },
    get groupPickTeams(){
      const by=new Map();
      for(const n of this.nurses||[]){const t=n.group||'';if(!by.has(t))by.set(t,[]);by.get(t).push(n)}
      return [...by].map(([team,nurses])=>({team,nurses}));
    },
    groupPickTeam(t){   // 팀 이름을 누르면 그 팀 전원을 넣고, 다 들어 있으면 뺀다
      const m=this.groupModal.data.members,ids=t.nurses.map(n=>n.id),all=ids.every(id=>m.includes(id));
      this.groupModal.data.members=all?m.filter(id=>!ids.includes(id)):[...new Set([...m,...ids])];
    },
    async saveGroupModal(){
      const d=this.groupModal.data,name=(d.name||'').trim();
      if(!name){this.toast('그룹 이름을 적어 주세요','warn');return}
      if(this.nurseGroupList.some(g=>g.id!==d.id&&g.name===name)){this.toast(`‘${name}’ 그룹이 이미 있어요`,'warn');return}
      const maxN=this._groupBound(d.maxN,2);
      if(d.same==='max'&&maxN===null){this.toast('한 근무 최대 인원은 2명 이상으로 적어 주세요 — 1명은 ‘같이 일하지 않기’입니다','warn');return}
      const minN=this._groupBound(d.minN,1);
      if(d.minOn&&minN===null){this.toast('한 근무 최소 인원은 1명 이상으로 적어 주세요','warn');return}
      const order=new Map(this.nurses.map((n,i)=>[n.id,i]));
      const g={id:d.id,name,members:d.members.filter(id=>order.has(id)).sort((a,b)=>order.get(a)-order.get(b)),
        maxPerShift:d.same==='alone'?1:d.same==='max'?maxN:null,minPerShift:d.minOn?minN:null};
      const list=this.nurseGroupList.slice(),i=list.findIndex(x=>x.id===g.id);
      if(i>=0)list[i]=g;else list.push(g);
      const fromPick=this.groupModal.isNew&&this.selectedNurseCount>0;
      this.groupModal.open=false;
      await this._saveGroups(list,`‘${name}’ 그룹 ${g.members.length}명을 저장했어요`);
      if(fromPick)this.clearNurseSelection();   // 고른 사람으로 만든 그룹 — 다른 일괄 작업처럼 고르기를 푼다
    },
    async deleteGroup(id){
      const g=this.nurseGroupList.find(x=>x.id===id);this.groupModal.open=false;
      if(g)await this._saveGroups(this.nurseGroupList.filter(x=>x.id!==id),`‘${g.name}’ 그룹을 지웠어요 — 간호사는 명부에 그대로 있어요`);
    },
    async addToGroup(g,ids){
      const have=new Set(g.members||[]),add=ids.filter(id=>!have.has(id));
      if(!add.length){this.toast(`이미 모두 ‘${g.name}’ 그룹에 있어요`,'info');return}
      const order=new Map(this.nurses.map((n,i)=>[n.id,i]));
      const members=[...have,...add].filter(id=>order.has(id)).sort((a,b)=>order.get(a)-order.get(b));
      await this._saveGroups(this.nurseGroupList.map(x=>x.id===g.id?{...x,members}:x),
        add.length>1?`${add.length}명을 ‘${g.name}’ 그룹에 넣었어요`:`${this.nurses.find(n=>n.id===add[0])?.name||''} → ‘${g.name}’ 그룹`);
    },
    async removeFromGroup(g,nid){
      await this._saveGroups(this.nurseGroupList.map(x=>x.id===g.id?{...x,members:(x.members||[]).filter(id=>id!==nid)}:x));
    },
    // 명부 순서 칸(⠿)을 끌어 그룹 칩에 놓기 — 끈 줄이 골라 둔 줄이면 고른 사람 모두
    dropOnGroup(g){
      const from=this._dragNurseIdx;this.groupDropId=null;this.onNurseDragEnd();
      const n=from===null?null:this.nurses[from];if(!n)return;
      this.addToGroup(g,this.selectedNurseMap[n.id]?this.selectedNurseIds:[n.id]);
    },
    // 근무표 주의 — 그룹 규칙을 못 지킨 근무 (엔진 _nurse_group_limits 와 같은 기준: 그 달 1일부터·끝에 붙은 다음 달 며칠까지,
    // 칸이 빈 날(재적 밖)·'/' 트레이닝 칸은 세지 않고, 최소는 그날 칸이 있는 그룹원 수까지만). 손으로 고친 뒤에도 다시 센다.
    groupWarnings(){
      if(!this.nurseGroupList.length||!this.schedule)return[];
      const periods=[['D',['day','day1']],['E',['evening','middle']],['N',['night']]]
        .map(([lab,ps])=>[lab,new Set(this.shifts.filter(s=>ps.includes(s.period)).map(s=>s.code))]);
      const firstKey=`${this.year}-${String(this.month).padStart(2,'0')}-01`;
      const days=this.scheduleDays.filter(d=>this.dayKey(d)>=firstKey);
      const list=(a,n=6)=>a.slice(0,n).join(' · ')+(a.length>n?` 외 ${a.length-n}개`:'');
      const out=[];
      for(const g of this.nurseGroupList){
        const mem=this.groupMembersOf(g),mx=this._groupBound(g.maxPerShift,0),mn=this._groupBound(g.minPerShift,1);
        if(!mem.length||(mx===null&&mn===null))continue;
        const over=[],under=[];
        for(const day of days){
          const dk=this.dayKey(day),md=`${day.getMonth()+1}/${day.getDate()}`;
          const here=mem.map(n=>[n,this.schedule[n.id]?.[dk]]).filter(([,v])=>v&&!v.startsWith('/'));
          for(const [lab,codes] of periods){
            const on=here.filter(([,v])=>codes.has(v)).map(([n])=>n.name);
            if(mx!==null&&on.length>mx)over.push(`${md} ${lab} ${on.join('·')}`);
            if(mn!==null&&on.length<Math.min(mn,here.length))under.push(`${md} ${lab} ${on.length}명`);
          }
        }
        if(over.length)out.push({type:'warn',nurse:`${g.name} 그룹`,msg:`${mx===1?'같이 일하지 않기':`한 근무 ${mx}명까지`}를 못 지킨 근무 ${over.length}개 — ${list(over)}`});
        if(under.length)out.push({type:'warn',nurse:`${g.name} 그룹`,msg:`한 근무 ${mn}명 이상을 못 지킨 근무 ${under.length}개 — ${list(under)}`});
      }
      return out;
    },

  };
};
