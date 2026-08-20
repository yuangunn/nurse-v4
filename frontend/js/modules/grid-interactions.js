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
      // v     = 생성을 실제로 막는 것 (알 수 없는 코드 등)
      // notes = 규칙과 다르지만 엔진이 '사실'로 수용하는 것 (사실-클램프, 결정 1-15)
      //         — 확정 셀만으로 결정되는 제약은 스킵/상한 클램프되므로 위반이 아니다.
      //         솔버가 조용히 무시하는 입력(공휴일 OF·임산부 야간/생)도 여기.
      const v=[],notes=[];
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
              notes.push({nid,dk:dk2,msg:`${nurse.name}: ${d1}${dn1} ${s1}→${d2}${dn2} ${s2} (${label} — 규칙과 다르지만 확정으로 수용)`});
          }
        }
      }
      // ── 확장 라인트 — 세는 것만으로 확정되는 하드 제약 (솔버 의미와 1:1) ──
      // 솔버가 '조용히 무시'하는 입력(공휴일 OF·임산부 야간 등, _effective_pre 대응)은
      // 위반이 아니라 '무시됨' 경고로 구분한다.
      const defByCode={};for(const s of this.shifts)defByCode[s.code]=s;
      const workPeriods=new Set(['day','day1','evening','middle','night']);
      const workCodes=this.shifts.filter(s=>workPeriods.has(s.period)).map(s=>s.code);
      const workSet=new Set(workCodes);
      const nightSet=new Set(nightCodes);
      const restSet=new Set(this.shifts.filter(s=>s.period==='rest').map(s=>s.code));
      const daySet=new Set(dayCodes);
      const flexMap={D:['D','DC'],DC:['D','DC'],E:['E','EC'],EC:['E','EC'],N:['N','NC'],NC:['N','NC']}; // 서버 _PRE_FLEX
      const monthKey=`${this.year}-${String(this.month).padStart(2,'0')}`;
      const firstKey=`${monthKey}-01`;
      const lastKey=this.dayKey(new Date(this.year,this.month,0));
      const holidaySet=new Set(this.holidays||[]);
      const r=this.rules||{};
      const fmtD=(day)=>`${day.getDate()}${dayNames[day.getDay()]}`;
      const extraCells=[];
      const pregSpanOf=(n)=>{ // [early.start ~ late.end] — 야간 금지 구간 (_preg_span_on)
        if(!n.is_pregnant)return null;
        const b=[];
        for(const k of['early','late']){const w=(n.pregnancy||{})[k]||{};if(w.start&&w.end&&w.start<=w.end)b.push(w)}
        return b.length?[b.map(w=>w.start).sort()[0],b.map(w=>w.end).sort().slice(-1)[0]]:null;
      };
      const effByNurse={};

      for(const nurse of this.nurses){
        const nid=nurse.id;
        const pre=this.prevSchedule[nid]||{};
        const span=pregSpanOf(nurse);
        const pregMonth=!!(span&&span[0]<=lastKey&&span[1]>=firstKey);
        const nm=nurse.night_months||{};
        let nightDed=Object.keys(nm).length?!!nm[monthKey]:!!nurse.is_night_shift;
        if(pregMonth)nightDed=false; // 임산부 달엔 야간전담 자동 해제 (솔버 동일)
        const capable=new Set(nurse.capable_shifts!==undefined?nurse.capable_shifts:workCodes);
        const eff={};effByNurse[nid]=eff; // dk → 유효 사전입력 (무시분 제외)
        const vDays=[],mDays=[],nDays=[];

        for(const day of days){
          const dk=this.dayKey(day);
          const code=pre[dk];
          if(!code)continue;
          if(code.startsWith('/'))continue; // 트레이니 표시 코드 — 솔버가 스트립
          const def=defByCode[code];
          if(!def){v.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} '${code}' 알 수 없는 근무 코드`});continue}
          if(code==='OF'&&holidaySet.has(dk)){notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} 공휴일 OF — 생성 시 무시되고 재배치됩니다`});continue}
          if(span&&nightSet.has(code)&&dk>=span[0]&&dk<=span[1]){notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} 임신 구간 야간 — 생성 시 무시됩니다 (모성보호)`});continue}
          if(pregMonth&&code==='생'){notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} 임신 달 생리휴가 — 생성 시 무시됩니다`});continue}
          eff[dk]=code;
          if(['day','evening','night'].includes(def.period)&&!(flexMap[code]||[code]).some(c=>capable.has(c)))
            notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} ${code} — 가능 근무에 없음 (자격 미달, 확정으로 수용)`});
          if(nightDed&&workSet.has(code)&&def.period!=='night')
            notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} ${code} — 야간전담의 야간 외 근무 (확정으로 수용)`});
          if(code==='생'&&nurse.gender!=='female')
            notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)} 생리휴가는 여성 전용 (확정으로 수용)`});
          if(dk>=firstKey&&dk<=lastKey){
            if(code==='V')vDays.push(dk);
            if(code==='생'&&nurse.gender==='female')mDays.push(dk);
            if(nightSet.has(code)&&!nightDed)nDays.push(dk);
          }
        }

        const maxV=+r.maxVPerMonth||0;
        if(maxV>0&&vDays.length>maxV)notes.push({nid,dk:vDays[maxV],msg:`${nurse.name}: V ${vDays.length}회 — 월 최대 ${maxV}회 (확정분은 그대로 수용)`});
        if(mDays.length>1)notes.push({nid,dk:mDays[1],msg:`${nurse.name}: 생리휴가 ${mDays.length}회 — 월 1회 한도 (확정분은 그대로 수용)`});
        if(!nightDed&&r.maxNightPerMonth&&nDays.length>(+r.maxNightPerMonthCount||6))
          notes.push({nid,dk:nDays[+r.maxNightPerMonthCount||6],msg:`${nurse.name}: 야간 ${nDays.length}회 — 월 최대 ${r.maxNightPerMonthCount}회 (확정분은 그대로 수용)`});
        if(!nightDed&&r.maxNightTwoMonth){
          // 나이트킵(야간전담) 달의 야간은 수면오프와 무관 → 합산에서 제외 (서버 동일)
          const pk=this.month===1?`${this.year-1}-12`:`${this.year}-${String(this.month-1).padStart(2,'0')}`;
          const prevKept=Object.keys(nm).length?!!nm[pk]:!!nurse.is_night_shift;
          const prevN=prevKept?0:(+((this.prevMonthNights||{})[nid])||0);
          const rhs=Math.max(0,(+r.maxNightTwoMonthCount||11)-prevN);
          if(nDays.length>rhs)notes.push({nid,dk:nDays[Math.min(rhs,nDays.length-1)],msg:`${nurse.name}: 당월 야간 ${nDays.length}회 + 전월 ${prevN}회 — 합산 ${r.maxNightTwoMonthCount}회 (확정분은 그대로 수용)`});
        }

        // 연속 근무/야간 — 선입력만으로 이미 확정된 초과 (빈칸은 보수적으로 run을 끊음)
        const maxW=r.maxConsecutiveWork?(+r.maxConsecutiveWorkDays||5):0;
        const maxCN=r.maxConsecutiveNight?(+r.maxConsecutiveNightDays||3):0;
        let runW=0,runN=0,flagW=false,flagN=false;
        for(const day of days){
          const dk=this.dayKey(day);
          const code=eff[dk];
          runW=code&&workSet.has(code)?runW+1:0;
          runN=code&&nightSet.has(code)?runN+1:0;
          if(!runW)flagW=false;
          if(!runN)flagN=false;
          if(maxW&&runW>maxW&&!flagW&&dk>=firstKey){flagW=true;notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)}까지 연속 근무 ${runW}일 — 최대 ${maxW}일 (확정으로 수용)`})}
          if(maxCN&&runN>maxCN&&!flagN&&dk>=firstKey){flagN=true;notes.push({nid,dk,msg:`${nurse.name}: ${fmtD(day)}까지 연속 야간 ${runN}일 — 최대 ${maxCN}일 (확정으로 수용)`})}
        }

        // N→휴무→D 금지 (noNOD) — 세 칸 모두 선입력일 때 확정
        if(r.noNOD){
          for(let i=0;i+2<days.length;i++){
            const dk3=this.dayKey(days[i+2]);
            if(dk3<firstKey)continue; // 전월 내부 완결 윈도우 — 솔버 미적용
            const c1=eff[this.dayKey(days[i])],c2=eff[this.dayKey(days[i+1])],c3=eff[dk3];
            if(c1&&c2&&c3&&nightSet.has(c1)&&restSet.has(c2)&&daySet.has(c3))
              notes.push({nid,dk:dk3,msg:`${nurse.name}: ${fmtD(days[i])}~${fmtD(days[i+2])} N→휴무→D 패턴 (확정으로 수용)`});
          }
        }

        // 주 1회 OF 의무 — 7일 주기(솔버 weeks와 동일 산식) 기준
        if(r.weeklyOff&&!nightDed){
          for(let w=0;w+6<days.length;w+=7){
            const wk=days.slice(w,w+7);
            const elig=wk.filter(d=>this.dayKey(d)>=firstKey&&!this.isNurseInactive(nurse,d));
            const ofs=elig.filter(d=>eff[this.dayKey(d)]==='OF');
            // OF 0회는 경고하지 않는다 — 결원으로 휴무가 몰리면 남은 사람이 오프를
            // 반납하고 근무를 메꾼다(오프특근, 제1원칙 3). 최소 보장은 주휴다.
            if(ofs.length>1)notes.push({nid,dk:this.dayKey(ofs[1]),msg:`${nurse.name}: ${fmtD(wk[0])}~${fmtD(wk[6])} 주에 OF ${ofs.length}회 — 규칙은 주 1회 (확정으로 수용)`});
          }
        }
      }

      // 일별 D/E/N 사전배정 초과 — 요구는 '정확히 일치'라 초과는 확정 실패
      const wkKeys2=['sun','mon','tue','wed','thu','fri','sat'];
      const periodOf={day:'D',evening:'E',night:'N'};
      for(const day of days){
        if(this.isOverflow(day))continue;
        const dk=this.dayKey(day);
        const req={...(this.requirements?.[wkKeys2[day.getDay()]]||{}),...(this.prevDayReqs?.[dk]||{})};
        const cnt={D:[],E:[],N:[]};
        for(const n of this.nurses){
          if(this.isNurseInactive(n,day))continue;
          const code=(effByNurse[n.id]||{})[dk];
          const p=code&&defByCode[code]?periodOf[defByCode[code].period]:null;
          if(p)cnt[p].push(n.id);
        }
        for(const p of['D','E','N']){
          const need=+req[p]||0;
          if(cnt[p].length>need){
            notes.push({nid:cnt[p][0],dk,msg:`${fmtD(day)} ${p} 사전배정 ${cnt[p].length}명 — 필요 ${need}명 (확정분에 맞춰 그날 인원이 상향됩니다)`});
            for(const id of cnt[p])extraCells.push(`${id}|${dk}`);
          }
        }
      }

      this.prevViolations=v;
      this.prevPinNotes=notes;
      this._violationSet=new Set(v.map(x=>`${x.nid}|${x.dk}`));
      this._pinNoteSet=new Set(notes.map(x=>`${x.nid}|${x.dk}`));
      for(const k of extraCells)this._pinNoteSet.add(k);
      this._checkStaffingSlack();
      // 실시간 생성 가능성 신호등 — 편집이 잦으니 디바운스로 프로브
      this._queueFeasibility&&this._queueFeasibility();
    },

    _checkStaffingSlack(){
      // 실시간 인원 슬랙 — 사전입력을 넣는 '그 자리에서' 부족/빡빡을 경고.
      // (생성 20분 돌리고 실패로 알게 되는 일을 입력 시점에 차단)
      const restLeave=this.shifts.filter(s=>s.period==='rest'||s.period==='leave').map(s=>s.code);
      const wkKeys=['sun','mon','tue','wed','thu','fri','sat'];
      const short=[],tight=[];
      for(const day of this.scheduleDays){
        if(this.isOverflow(day))continue;
        const dk=this.dayKey(day);
        const base=this.requirements?.[wkKeys[day.getDay()]]||{};
        const ovr=this.prevDayReqs?.[dk]||{};
        const req={...base,...ovr};
        const needed=(+req.D||0)+(+req.E||0)+(+req.N||0);
        if(!needed)continue;
        let avail=0;
        for(const n of this.nurses){
          if((n.start_date&&dk<n.start_date)||(n.end_date&&dk>n.end_date))continue;
          const pre=this.prevSchedule[n.id]?.[dk];
          if(pre&&restLeave.includes(pre))continue;
          avail++;
        }
        if(avail<needed)short.push({dk,needed,avail});
        else if(avail===needed)tight.push({dk,needed,avail});
      }
      this.staffingAlerts={short,tight};
    },
    hasViolation(nurseId,day){
      return this._violationSet?.has(`${nurseId}|${this.dayKey(day)}`)||false;
    },
    hasPinNote(nurseId,day){
      return this._pinNoteSet?.has(`${nurseId}|${this.dayKey(day)}`)||false;
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
      else if(event.key.toLowerCase()==='z'&&(event.ctrlKey||event.metaKey)){event.shiftKey?this.redo():this.undo();event.preventDefault();return}
      else{
        // 근무코드 직접 입력 (ㅂ=병가, ㅃ(Shift+ㅂ)=법정공휴일 — 객체 리터럴 중복 키로
        // '병' 입력이 불가능하고 ㅂ가 '법'을 입력하던 버그 수정)
        const key=event.key.toUpperCase();
        const shiftMap={'D':'D','E':'E','N':'N','V':'V','O':'OF','W':'주'};
        const hangulMap={'ㅈ':'주','ㅂ':'병','ㅃ':'법','ㅅ':'생','ㅌ':'특','ㄱ':'공'};
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
