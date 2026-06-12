/* ────────────────────────────────────────────────────────────────────────────
 * 설정 정의 — 규칙·프리셋·요구사항·근무 정의·셀 색상 맵·배점 (+ 스케줄 비교)
 *
 * 사용: app() 반환 객체에 `...SettingsDefsModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.SettingsDefsModule = function() {
  return {
    // ── 규칙 ──────────────────────────────────────────────────
    async loadRules(){
      // DB 값으로 기본값을 덮어쓰기 (없는 필드는 기본값 유지)
      const loaded=await this.api('GET','/api/rules');
      this.rules={...this.rules,...loaded};
    },
    async saveRules(){await this.api('POST','/api/rules',this.rules);this.toast('규칙이 저장되었습니다','info')},

    // ── 규칙 프리셋 ──────────────────────────────────────────
    rulePresets:JSON.parse(localStorage.getItem('ns_rule_presets')||'[]'),
    showRulePresets:false,
    saveRulePreset(){
      const name=this._safePrompt('프리셋 이름을 입력하세요 (예: 엄격/유연/야간 중심)','새 프리셋');
      if(!name)return;
      this.rulePresets.push({name,rules:JSON.parse(JSON.stringify(this.rules)),created:new Date().toISOString().slice(0,16)});
      localStorage.setItem('ns_rule_presets',JSON.stringify(this.rulePresets));
      this.toast(`규칙 프리셋 "${name}" 저장 완료`);
    },
    loadRulePreset(idx){
      const p=this.rulePresets[idx];if(!p)return;
      if(!confirm(`"${p.name}" 프리셋을 불러오시겠습니까?\n현재 규칙 설정이 교체됩니다.`))return;
      this.rules={...this.rules,...p.rules};
      this.toast(`프리셋 "${p.name}" 적용됨. '저장' 버튼으로 서버에 반영하세요.`,'info',5000);
    },
    deleteRulePreset(idx){
      this.rulePresets.splice(idx,1);
      localStorage.setItem('ns_rule_presets',JSON.stringify(this.rulePresets));
    },

    // ── 스케줄 비교 ──────────────────────────────────────────
    compareResult:null,
    async compareWithSaved(savedId){
      try{
        const savedData=await this.api('GET',`/api/schedules/${savedId}`);
        const saved=savedData.data?.schedule||savedData.data||{};
        const current=this.schedule||{};
        const diffs=[];
        const allNurses=new Set([...Object.keys(current),...Object.keys(saved)]);
        for(const nid of allNurses){
          const curDays=current[nid]||{};
          const savDays=saved[nid]||{};
          const allDays=new Set([...Object.keys(curDays),...Object.keys(savDays)]);
          for(const dk of allDays){
            const c=curDays[dk]||'-';
            const s=savDays[dk]||'-';
            if(c!==s){
              const nurse=this.nurses.find(n=>n.id===nid);
              diffs.push({nid,name:nurse?.name||nid,dk,current:c,saved:s});
            }
          }
        }
        this.compareResult={
          savedName:savedData.name||`${savedData.year}년 ${savedData.month}월`,
          totalDiffs:diffs.length,
          diffs:diffs.slice(0,50),
          hasMore:diffs.length>50,
        };
      }catch(e){this.toast('비교 실패: '+e.message,'error')}
    },

    // ── 요구사항 ──────────────────────────────────────────────
    async loadRequirements(){this.requirements=await this.api('GET','/api/requirements')},
    async saveRequirements(){await this.api('POST','/api/requirements',this.requirements);this.toast('인원 설정이 저장되었습니다','info')},

    // ── 근무 관리 ─────────────────────────────────────────────
    async loadShifts(){this.shifts=await this.api('GET','/api/shifts')},
    // ── Clinical Paper cell color map (Phase 4) ──
    // shift code → [bg-var, ink-var, font-weight]
    // 페이퍼 톤 + 잉크 — DB-defined color는 fallback으로만 사용
    _CLINICAL_CELL_MAP: {
      'D':  ['--d-bg', '--d-ink', '600'],
      'DC': ['--d-bg', '--d-ink', '700'],
      'D1': ['--d-bg', '--d-ink', '600'],
      'E':  ['--e-bg', '--e-ink', '600'],
      'EC': ['--e-bg', '--e-ink', '700'],
      '중':  ['--e-bg', '--e-ink', '600'],
      'N':  ['--n-bg', '--n-ink', '600'],
      'NC': ['--n-bg', '--n-ink', '700'],
      'OF': ['transparent', '--off-ink', '400'],
      '주':  ['--paper-2', '--ink-4', '600'],
      'V':  ['--v-bg', '--v-ink', '600'],
      '생':  ['--v-bg', '--v-ink', '600'],
      '특':  ['--v-bg', '--v-ink', '600'],
      '공':  ['--v-bg', '--v-ink', '600'],
      '법':  ['--v-bg', '--v-ink', '600'],
      '병':  ['--v-bg', '--v-ink', '600'],
    },
    getShiftStyle(code){
      // 트레이니 /D → D로 매핑
      const baseCode=code?.startsWith('/')?code.slice(1):code;
      const entry=this._CLINICAL_CELL_MAP[baseCode];
      if(entry){
        const [bg, ink, weight]=entry;
        const style={
          background: bg==='transparent'?'transparent':`var(${bg})`,
          color: `var(${ink})`,
          fontWeight: weight,
        };
        // 주(주휴)는 italic
        if(baseCode==='주') style.fontStyle='italic';
        if(code?.startsWith('/')){
          // 트레이니: opacity 낮추고 italic
          style.opacity='0.55';
          style.fontStyle='italic';
        }
        return style;
      }
      // fallback: DB-defined shift (사용자가 새 코드 추가한 경우)
      const s=this.shiftMap.get(baseCode);if(!s)return {};
      if(code?.startsWith('/')){
        return{background:s.color_bg+'80',color:s.color_text+'99',fontStyle:'italic',opacity:'0.55'};
      }
      return{background:s.color_bg,color:s.color_text};
    },
    // 스케줄 탭용 셀 스타일
    hideCharge:true, colorByShift:true, showCompareMenu:false, showMobileMore:false,
    // 전입/전출 범위 체크
    isNurseInactive(nurse, day){
      if(!nurse)return false;
      const ymd=this.dayKey(day);
      if(nurse.start_date&&ymd<nurse.start_date)return 'before';  // 전입 전
      if(nurse.end_date&&ymd>nurse.end_date)return 'after';       // 전출 후
      return false;
    },

    _getShift(nurseId, day){
      const k=this.dayKey(day);
      const s=this.schedule?.[nurseId]?.[k];
      if(s)return s;
      return this.extendedSchedule?.[nurseId]?.[k]||'';
    },
    getScheduleCellClass(nurseId, day){
      const shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return '';
      const k=this.dayKey(day);
      const isPre=!!(this.prevSchedule[nurseId]&&this.prevSchedule[nurseId][k]);
      if(this.colorByShift)return '';  // 근무별 색상 모드: class 없이 style로 처리
      if(isPre)return 'g-cell-pre';
      const s=this.shiftMap.get(shift);
      if(!s)return '';
      if(s.period==='rest'||s.period==='leave')return 'g-cell-rest';
      return 'g-cell-work';
    },
    getScheduleCellStyle(nurseId, day){
      if(!this.colorByShift)return {};
      let shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return {};
      if(this.hideCharge){if(shift==='DC')shift='D';if(shift==='EC')shift='E';if(shift==='NC')shift='N'}
      return this.getShiftStyle(shift);
    },
    displayShift(nurseId, day){
      let shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return '';
      if(this.hideCharge){if(shift==='DC')shift='D';if(shift==='EC')shift='E';if(shift==='NC')shift='N'}
      return shift;
    },
    _hexToHsl(hex){
      if(!hex||!hex.startsWith('#')||hex.length<7)return[0,0,50];
      const r=parseInt(hex.slice(1,3),16)/255,g=parseInt(hex.slice(3,5),16)/255,b=parseInt(hex.slice(5,7),16)/255;
      const max=Math.max(r,g,b),min=Math.min(r,g,b);let h=0,s=0,l=(max+min)/2;
      if(max!==min){const d=max-min;s=l>0.5?d/(2-max-min):d/(max+min);switch(max){case r:h=((g-b)/d+(g<b?6:0))/6;break;case g:h=((b-r)/d+2)/6;break;case b:h=((r-g)/d+4)/6;break}}
      return[h*360,s*100,l*100];
    },
    // 톤온톤: 투명한 배경 + 밝은 텍스트 (다크 글래스 위)
    _shiftGlassBg(hex){const[h,s]=this._hexToHsl(hex);return`hsla(${h},${Math.min(s,60)}%,50%,0.15)`},
    _shiftGlassText(hex){const[h,s]=this._hexToHsl(hex);return`hsl(${h},${Math.min(s*1.1,70)}%,75%)`},
    // v2 호환용 (미사용이지만 보존)
    _shiftDarkBg(hex){const[h,s]=this._hexToHsl(hex);return`hsl(${h},${Math.max(s*0.8,35)}%,20%)`},
    _shiftDarkText(hex){const[h,s]=this._hexToHsl(hex);return`hsl(${h},${Math.min(s*1.2,80)}%,78%)`},
    openShiftModal(shift){
      this.shiftModal.isNew=!shift;
      this.shiftModal.data=shift?JSON.parse(JSON.stringify(shift)):{code:'',name:'',period:'day',is_charge:false,auto_assign:true,hours:'',color_bg:'#dbeafe',color_text:'#1d4ed8',sort_order:this.shifts.length};
      this.shiftModal.open=true;
    },
    async saveShift(){const d=this.shiftModal.data;if(!d.code.trim()){this.toast('코드를 입력하세요','error');return}if(!d.name.trim()){this.toast('이름을 입력하세요','error');return}await this.api('POST','/api/shifts',d);await this.loadShifts();this.shiftModal.open=false},
    async deleteShift(code){
      const PROTECTED=['DC','D','D1','EC','E','중','NC','N','OF','주'];
      if(PROTECTED.includes(code)){this.toast('기본 근무는 삭제할 수 없습니다','error');return}
      if(!confirm(`'${code}' 근무를 삭제하시겠습니까?`))return;await this.api('DELETE',`/api/shifts/${code}`);await this.loadShifts();
    },

    // ── 배점 관리 ─────────────────────────────────────────────
    async loadScoringRules(){this.scoringRules=await this.api('GET','/api/scoring_rules')},
    scoringRuleTypeLabel(rt){return{transition:'전환 패턴',pattern:'N일 패턴',consecutive_same:'연속 동일',specific_shift:'특정 근무',wish:'희망 근무',night_fairness:'야간 공평성',holiday_work:'공휴일 근무',weekend_work:'주말 근무',holiday_off:'공휴일 OFF'}[rt]||rt},
    scoringRuleCondSummary(r){
      const p=r.params||{};const gl=v=>({work:'모든근무',day:'낮',evening:'저녁',night:'야간',rest:'휴무',leave:'휴가',rest_leave:'휴무/휴가',any:'전체'})[v]||v;
      if(r.rule_type==='transition')return`${gl(p.from)} → ${gl(p.to)}`;
      if(r.rule_type==='pattern')return(p.pattern||[]).map(v=>({work:'근무',day:'낮',evening:'저녁',night:'야간',rest:'휴무',leave:'휴가',rest_leave:'휴무/휴가',any:'전체'})[v]||v).join(' → ');
      if(r.rule_type==='consecutive_same')return`연속 ${gl(p.period)} 쌍`;
      if(r.rule_type==='specific_shift')return`${p.shift_code||'-'}${p.condition==='female_only'?' (여성)':''}`;
      if(r.rule_type==='wish')return'희망 근무 매칭';
      if(r.rule_type==='night_fairness')return'야간 range 최소화';
      if(r.rule_type==='holiday_work')return'공휴일 근무 시 가점';
      if(r.rule_type==='holiday_off')return'공휴일 OFF 시 감점';
      if(r.rule_type==='weekend_work'){const s=p.slots||[];const dnames=['월','화','수','목','금','토','일'];const pnames={day:'D',evening:'E',night:'N'};return s.map(sl=>`${dnames[sl.weekday]} ${(sl.periods||[]).map(pp=>pnames[pp]||pp).join('/')}`).join(', ')||'-'}
      return'-';
    },
    openScoringModal(rule){
      this.scoringModal.isNew=!rule;
      if(rule)this.scoringModal.data=JSON.parse(JSON.stringify(rule));
      else this.scoringModal.data={name:'',rule_type:'transition',score:0,enabled:true,sort_order:this.scoringRules.length,params:{from:'day',to:'night'}};
      this.scoringModal.open=true;
    },
    initScoringParams(rt){
      if(rt==='transition')this.scoringModal.data.params={from:'day',to:'night'};
      else if(rt==='pattern')this.scoringModal.data.params={pattern:['work','rest_leave','work']};
      else if(rt==='consecutive_same')this.scoringModal.data.params={period:'day'};
      else if(rt==='specific_shift')this.scoringModal.data.params={shift_code:this.shifts[0]?.code||'V',condition:'all'};
      else if(rt==='holiday_work')this.scoringModal.data.params={};
      else if(rt==='holiday_off')this.scoringModal.data.params={};
      else if(rt==='weekend_work')this.scoringModal.data.params={slots:[{weekday:5,periods:['evening','night']},{weekday:6,periods:['day']}]};
      else this.scoringModal.data.params={};
    },
    async saveScoringRule(){const d=this.scoringModal.data;if(!d.name.trim()){this.toast('규칙 이름을 입력하세요','error');return}await this.api('POST','/api/scoring_rules',d);await this.loadScoringRules();this.scoringModal.open=false},
    async toggleScoringRule(rule){await this.api('POST','/api/scoring_rules',{...rule,enabled:!rule.enabled});await this.loadScoringRules()},
    async deleteScoringRule(id){if(!confirm('이 배점 규칙을 삭제하시겠습니까?'))return;await this.api('DELETE',`/api/scoring_rules/${id}`);await this.loadScoringRules()},

  };
};
