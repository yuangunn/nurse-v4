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

    // ── 병원 휴일 (매년) — 설정 → 규칙. 저장은 위의 규칙 저장 버튼 ──
    // 옛 저장본·템플릿을 불러와 rules 에 목록이 없으면 기본값(misc-features.js)을 보여 준다
    get hospitalHolidayList(){ return this.rules?.hospitalHolidays ?? this._HOSPITAL_HOLIDAYS_DEFAULT; },
    _ownHospitalHolidays(){
      if(!Array.isArray(this.rules.hospitalHolidays))
        this.rules.hospitalHolidays=this._HOSPITAL_HOLIDAYS_DEFAULT.map(h=>({...h}));
      return this.rules.hospitalHolidays;
    },
    // '5/1'·'5-1'·'5월 1일'·'0501' → '05-01' (못 읽으면 null)
    _normMD(v){
      const t=String(v||'').trim();
      let m=t.match(/^([0-9]{1,2})\s*[-/.월]\s*([0-9]{1,2})\s*일?$/)||t.match(/^([0-9]{2})([0-9]{2})$/);
      if(!m)return null;
      const mo=+m[1], d=+m[2];
      const dt=new Date(Date.UTC(2024,mo-1,d));   // 윤년 — 2월 29일도 받는다
      if(dt.getUTCMonth()!==mo-1||dt.getUTCDate()!==d)return null;
      return `${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    },
    setHospitalHoliday(i, key, v){
      const list=this._ownHospitalHolidays(); if(!list[i])return;
      if(key==='md'){
        const md=this._normMD(v);
        if(!md){this.toast('날짜는 월-일로 적어 주세요 (예: 05-01)','warn');list[i]={...list[i]};return}
        list[i]={...list[i],md};
      }else list[i]={...list[i],name:String(v||'').trim()};
    },
    addHospitalHoliday(){ this._ownHospitalHolidays().push({md:'',name:''}); },
    removeHospitalHoliday(i){ this._ownHospitalHolidays().splice(i,1); },

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
      '경가': ['--v-bg', '--v-ink', '600'],
      '조가': ['--v-bg', '--v-ink', '600'],
      '산전': ['--v-bg', '--v-ink', '600'],
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
    // hideCharge = 화면 전용. 인쇄·엑셀은 늘 D/E/N (병동 번표에는 누가 차지인지 나오지 않는다 — 2026-10-03 병동 확인).
    // _printPlain = Ctrl+P 로 화면을 바로 인쇄할 때 잠깐 켜진다 (redesign.js beforeprint).
    hideCharge:true, _printPlain:false, colorByShift:true, showCompareMenu:false, showMobileMore:false,
    // 근무표 보기 옵션 (결정 1-82) — 화면 전용, 인쇄·엑셀은 그대로.
    //  viewWorkRest: 근무/쉬는 날 두 색으로만 (근무별 색·원티드·나이트킵 색을 끈다) — 누가 길게 일하고 길게 쉬는지 보려고
    //  showWantedColor: 원티드(분홍) 칸 색
    viewWorkRest:false, showWantedColor:true,
    // 강조해서 보기 (결정 1-87) — 여러 개를 함께 켤 수 있다. 켠 것에 드는 칸만 또렷하고 나머지는 흐려진다.
    //  근무: singleN 단독 야간 · night3 3일 이상 연속 야간 · run6 6일 이상 연속 근무 · weekendWork 주말·공휴일 근무
    //  휴무: oneOff 1오프 · longOff 긴 근무 사이 1오프(앞뒤 근무를 합쳐 8일 이상 — 그 근무까지) · nightRest1 야간 뒤 하루만 쉬고 근무 ·
    //        juhuAlone 혼자인 주휴(앞뒤에 쉬는 날이 없다) · longRest 3일 이상 휴무
    //  그 밖: pongdang 퐁당퐁당(하루 근무·하루 휴무가 번갈아 나흘 이상) · edited 손으로 고친 칸
    viewHl:{},
    rdHlDefs(){ return [
      ['singleN','단독 야간','앞뒤가 야간이 아닌 하루짜리 야간','근무'], ['night3','3일 이상 연속 야간','야간이 사흘 넘게 이어지는 곳','근무'],
      ['run6','6일 이상 연속 근무','쉬는 날 없이 6일 넘게 이어지는 근무','근무'], ['weekendWork','주말·공휴일 근무','토·일요일과 공휴일에 일하는 칸','근무'],
      ['oneOff','1오프','앞뒤가 근무인 하루짜리 휴무','휴무'],
      ['longOff','근무 4 + 1오프 + 근무 4','1오프의 앞뒤 근무를 합쳐 8일 이상 — 4-1-4 · 5-1-3 · 5-1-5 같은 모양. 앞뒤 근무까지 함께 표시합니다','휴무'],
      ['nightRest1','야간 뒤 하루만 쉬고 근무','야간 다음에 하루만 쉬고 다시 근무하는 곳의 그 쉬는 날','휴무'],
      ['juhuAlone','혼자인 주휴','앞뒤에 쉬는 날이 붙지 않은 주휴','휴무'], ['longRest','3일 이상 휴무','쉬는 날이 사흘 넘게 붙은 곳','휴무'],
      ['pongdang','퐁당퐁당','하루 근무·하루 휴무가 번갈아 나흘 넘게 이어지는 구간','그 밖에'], ['edited','손으로 고친 칸','근무표를 만든 뒤 직접 바꾼 칸','그 밖에'],
      ['draftDiff','처음 표와 달라진 칸','이번 만들기에서 처음 나온 표(초안)와 근무가 다른 칸 — 더 찾아서 바뀐 곳','그 밖에']]; },
    rdHlGroups(){ const g=[]; for(const h of this.rdHlDefs()){ const last=g[g.length-1]; if(last&&last.name===h[3])last.items.push(h); else g.push({name:h[3],items:[h]}); } return g; },
    get rdHlOn(){ return Object.values(this.viewHl||{}).some(Boolean); },
    // 한 줄을 근무(W)·야간 근무(N)·쉬는 날(R)·빈칸('')으로, 날마다 곁들일 것(주휴인가·주말·공휴일인가·손으로 고쳤나)과 함께
    _hlRow(nurse){
      const row=[], juhu=[], wk=[], ed=[], df=[];
      for(const d of this.scheduleDays){
        const s=this.isNurseInactive(nurse,d)?'':this._getShift(nurse.id,d), p=s&&s!=='-'?(this.shiftMap.get(s)||{}).period:'';
        row.push(!p?'':(p==='rest'||p==='leave'?'R':(p==='night'?'N':'W'))); juhu.push(s==='주');
        wk.push(d.getDay()===0||d.getDay()===6||this.isHoliday(d)); ed.push(!!this.isManuallyEdited(nurse.id,d)); df.push(!!(this.genFirst&&this.isDraftDiff(nurse.id,d)));
      }
      return {row, juhu, wk, ed, df};
    },
    // 날마다 걸리는 표시들 — out[i] = [표시 이름…], count = {표시: 건수}. 통째로 표시하는 것(긴 근무 사이 1오프·연속 근무·연속 야간·긴 휴무·퐁당퐁당)은 묶음 하나가 한 건
    _hlMarks(row, x){
      const n=row.length, w=i=>row[i]==='W'||row[i]==='N', juhu=(x&&x.juhu)||[], wk=(x&&x.wk)||[], ed=(x&&x.ed)||[], df=(x&&x.df)||[], out=row.map(()=>[]), count={};
      for(const h of this.rdHlDefs())count[h[0]]=0;
      const put=(i,k)=>{ if(!out[i].includes(k))out[i].push(k); };
      for(let i=0;i<n;i++){
        if(w(i)&&wk[i]){ put(i,'weekendWork'); count.weekendWork++; }
        if(ed[i]){ put(i,'edited'); count.edited++; }
        if(df[i]){ put(i,'draftDiff'); count.draftDiff++; }
        if(i===0||i===n-1)continue;                       // 맨 앞·맨 끝은 앞뒤를 모른다
        if(row[i]==='N'&&row[i-1]&&row[i+1]&&row[i-1]!=='N'&&row[i+1]!=='N'){ put(i,'singleN'); count.singleN++; }
        if(row[i]==='R'&&row[i-1]==='N'&&w(i+1)){ put(i,'nightRest1'); count.nightRest1++; }
        if(juhu[i]&&row[i]==='R'&&row[i-1]&&row[i+1]&&row[i-1]!=='R'&&row[i+1]!=='R'){ put(i,'juhuAlone'); count.juhuAlone++; }
        if(row[i]==='R'&&w(i-1)&&w(i+1)){ put(i,'oneOff'); count.oneOff++;
          let L=0,R=0; for(let j=i-1;j>=0&&w(j);j--)L++; for(let j=i+1;j<n&&w(j);j++)R++;
          if(L+R>=8){ count.longOff++; for(let j=i-L;j<=i+R;j++)put(j,'longOff'); } }
      }
      // 이어진 묶음 — 같은 종류(근무·야간·휴무)가 붙은 구간
      const runs=[]; for(let i=0;i<n;){ if(!row[i]){i++;continue} const t=w(i)?'W':'R'; let j=i; while(j+1<n&&row[j+1]&&(w(j+1)?'W':'R')===t)j++; runs.push([i,j,t]); i=j+1; }
      for(const [a,b,t] of runs){
        if(t==='W'&&b-a+1>=6){ count.run6++; for(let k=a;k<=b;k++)put(k,'run6'); }
        if(t==='R'&&b-a+1>=3){ count.longRest++; for(let k=a;k<=b;k++)put(k,'longRest'); }
      }
      for(let i=0;i<n;){ if(row[i]!=='N'){i++;continue} let j=i; while(j+1<n&&row[j+1]==='N')j++; if(j-i+1>=3){ count.night3++; for(let k=i;k<=j;k++)put(k,'night3'); } i=j+1; }
      // 퐁당퐁당 — 하루짜리 묶음이 끊기지 않고 넷 이상 번갈아 온다
      for(let r=0;r<runs.length;){ if(runs[r][0]!==runs[r][1]){r++;continue} let e=r; while(e+1<runs.length&&runs[e+1][0]===runs[e+1][1]&&runs[e+1][0]===runs[e][1]+1)e++;
        if(e-r+1>=4){ count.pongdang++; for(let k=runs[r][0];k<=runs[e][1];k++)put(k,'pongdang'); } r=e+1; }
      return {out, count};
    },
    rdCellHl(nurse, di){
      if(!this.rdHlOn)return '';
      const R=this._hlRow(nurse), on=(this._hlMarks(R.row, R).out[di]||[]).filter(k=>this.viewHl[k]);
      return on.length?'hl '+on.map(k=>'hl-'+k).join(' '):'hl-dim';
    },
    // 메뉴에 보이는 건수 — 지금 화면에 있는 줄(팀·그룹만 보기를 따른다)
    get rdHlCounts(){
      const c={}; for(const h of this.rdHlDefs())c[h[0]]=0;
      for(const n of (this.rdPhoneNurses||this.nurses||[])){ const R=this._hlRow(n), k=this._hlMarks(R.row, R).count; for(const x in c)c[x]+=k[x]||0; }
      return c;
    },
    rdHlClear(){ this.viewHl={}; },
    // 근무·휴무만 보기일 때 칸의 색 클래스 — 휴무·휴가는 쉬는 날, 나머지는 근무. 빈칸·재적 밖은 색 없음
    rdCellTone(nurse, day){
      if(!this.viewWorkRest||this.isNurseInactive(nurse,day))return '';
      const s=this._getShift(nurse.id,day); if(!s||s==='-')return '';
      const info=this.shiftMap.get(s);
      return info&&(info.period==='rest'||info.period==='leave')?'vw-rest':'vw-work';
    },
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
    // 원티드 '둘 중 하나'(D/E·E/N·D/N)·'N 빼고'(N제외) — 한 근무가 아니라 허용 근무 묶음 (제1원칙 14).
    // 엔진 _FLEX_ONE_OF·_FLEX_NOT 와 같은 뜻: 둘 중 하나 = 두 시간대 근무(차지 포함, D1·중 아님), N제외·D제외·E제외 = 그 시간대만 아니면 됨.
    flexWishCodes:['D/E','E/N','D/N','D/E/N','D제외','E제외','N제외','D/OF','E/OF','N/OF'],
    isFlexWish(code){return this.flexWishCodes.includes(code)},
    flexAllows(code, shift){
      const p=this.shiftMap.get(shift)?.period||'';
      const not={'N제외':['night'],'D제외':['day'],'E제외':['evening'],'D/OF':['evening','night'],'E/OF':['day','night'],'N/OF':['day','evening']}[code];
      if(not)return !!shift&&!not.includes(p);
      return ({'D/E':['day','evening'],'E/N':['evening','night'],'D/N':['day','night'],'D/E/N':['day','evening','night']}[code]||[]).includes(p);
    },
    // 차지 코드 → 일반 코드 (DC→D, EC→E, NC→N, 신규 /DC→/D). 그 밖의 코드는 그대로.
    // 어싸인용 복사(copyScheduleTsv)는 이것을 거치지 않는다 — 배정표가 DC/EC/NC 로 차지를 안다.
    plainShift(code){
      if(!code)return code;
      const pre=code.startsWith('/')?'/':'';
      const base=pre?code.slice(1):code;
      const plain={DC:'D',EC:'E',NC:'N'}[base];
      return plain?pre+plain:code;
    },
    getScheduleCellStyle(nurseId, day){
      if(!this.colorByShift)return {};
      let shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return {};
      if(this.hideCharge||this._printPlain)shift=this.plainShift(shift);
      return this.getShiftStyle(shift);
    },
    displayShift(nurseId, day){
      let shift=this._getShift(nurseId,day);
      if(!shift||shift==='-')return '';
      if(this.hideCharge||this._printPlain)shift=this.plainShift(shift);
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
    // ── 근무 시간 (결정 1-92) — 엔진이 이 시간으로 보탠 근무 앞뒤의 휴식을 잰다. 서버 parse_shift_hours·_hours_transition_rules 와 같아야 한다 ──
    BUILTIN_WORK:['DC','D','D1','EC','E','중','NC','N'], WORK_PERIODS:['day','day1','evening','middle','night'],
    // '06:00~14:00' → [시작 분, 끝 분]. 끝이 시작보다 이르거나 같으면 자정을 넘긴 근무. 읽을 수 없으면 null
    parseShiftHours(text){
      const m=/^\s*(\d{1,2}):(\d{2})\s*[~\-–—]\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text||'')); if(!m) return null;
      const [h1,m1,h2,m2]=m.slice(1).map(Number); if(h1>24||h2>24||m1>59||m2>59) return null;
      const s=h1*60+m1; let e=h2*60+m2; if(e<=s) e+=1440; return [s,e];
    },
    // 시간대끼리의 역순 9종 — [앞 코드들, 뒤 코드들, 라벨, 마지막 수단인가]
    categoryTransitionRules(){
      const P=p=>this.shifts.filter(s=>s.period===p).map(s=>s.code), E=P('evening'), M=P('middle'), N=P('night'), D=P('day'), D1=P('day1');
      const soft=(this.rules||{}).rareTransitionLastResort!==false;
      return [[E,D,'E→D',false],[E,D1,'E→D1',soft],[E,M,'E→중',false],[N,E,'N→E',false],[N,D,'N→D',false],[N,D1,'N→D1',false],[N,M,'N→중',false],[M,D,'중→D',soft],[M,D1,'중→D1',false]];
    },
    // 보탠 근무가 낀 전환 가운데 실제 휴식이 모자란 쌍 — [[앞], [뒤], 라벨, false]. 기본 근무끼리는 역순 9종이 답이라 넣지 않는다
    hoursTransitionRules(){
      const r=this.rules||{}; if(r.minRest===false) return []; const need=(parseFloat(r.minRestHours)||0)*60; if(need<=0) return [];
      const work=this.shifts.filter(s=>this.WORK_PERIODS.includes(s.period)), custom=new Set(work.filter(s=>!this.BUILTIN_WORK.includes(s.code)).map(s=>s.code)); if(!custom.size) return [];
      const hrs=Object.fromEntries(work.map(s=>[s.code, this.parseShiftHours(s.hours)])), hard=this.categoryTransitionRules().filter(x=>!x[3]), out=[];
      for(const a of work) for(const b of work){ if((!custom.has(a.code)&&!custom.has(b.code))||!hrs[a.code]||!hrs[b.code]) continue;
        const rest=1440+hrs[b.code][0]-hrs[a.code][1]; if(rest>=need||hard.some(x=>x[0].includes(a.code)&&x[1].includes(b.code))) continue;
        out.push([[a.code],[b.code],`${a.code}→${b.code}, 휴식 ${+(Math.max(0,rest)/60).toFixed(2)}시간`,false]); }
      return out;
    },
    // 근무 정의 창의 시작·끝 시각 칸 (i=0 시작, 1 끝) — 값은 '06:00~14:00' 한 줄로 둔다
    isWorkPeriod(p){ return this.WORK_PERIODS.includes(p); },
    shiftHoursPart(i){ const m=/^\s*(\d{1,2}:\d{2})\s*[~\-–—]\s*(\d{1,2}:\d{2})\s*$/.exec(String(this.shiftModal.data.hours||'')); if(!m) return (this.shiftModal.parts||['',''])[i]||''; const v=m[i+1]; return (v.length===4?'0':'')+(v==='24:00'?'00:00':v); },
    setShiftHoursPart(i, v){ const p=[this.shiftHoursPart(0), this.shiftHoursPart(1)]; p[i]=v||''; this.shiftModal.parts=p; this.shiftModal.data.hours=(p[0]&&p[1]) ? `${p[0]}~${p[1]}` : ''; },
    // 보탠 근무인데 시간이 없으면 휴식 규칙을 걸 수 없다 — 근무 목록에 알린다
    shiftNeedsHours(s){ return this.isWorkPeriod(s.period) && !this.BUILTIN_WORK.includes(s.code) && !this.parseShiftHours(s.hours); },
    get shiftHoursHint(){ const d=(this.shiftModal||{}).data||{}; if(!this.isWorkPeriod(d.period)) return '';
      const h=this.parseShiftHours(d.hours), len=h ? ` 근무 ${+((h[1]-h[0])/60).toFixed(2)}시간${h[1]>1440?' (자정을 넘깁니다)':''}.` : '';
      return this.BUILTIN_WORK.includes(d.code)
        ? '기본 근무끼리의 전환은 정해진 규칙(E→D 금지 등)을 따릅니다. 이 시간은 새로 보탠 근무와 이어질 때 휴식을 재는 데 씁니다.'+len
        : `이 시간으로 앞뒤 근무 사이의 휴식을 잽니다 — ${(this.rules||{}).minRest===false ? '지금은 규칙이 꺼져 있습니다' : ((this.rules||{}).minRestHours??11)+'시간보다 짧으면 그 전환을 막습니다'}.`+len; },
    openShiftModal(shift){
      this.shiftModal.isNew=!shift;
      this.shiftModal.parts=null;   // 시작·끝 중 하나만 넣은 값은 창을 새로 열면 버린다
      this.shiftModal.data=shift?JSON.parse(JSON.stringify(shift)):{code:'',name:'',period:'day',is_charge:false,auto_assign:true,hours:'',color_bg:'#dbeafe',color_text:'#1d4ed8',sort_order:this.shifts.length};
      this.shiftModal.open=true;
    },
    async saveShift(){const d=this.shiftModal.data;if(!d.code.trim()){this.toast('코드를 입력하세요','error');return}if(!d.name.trim()){this.toast('이름을 입력하세요','error');return}
      if(!this.isWorkPeriod(d.period))d.hours='-';
      else if(!this.BUILTIN_WORK.includes(d.code)&&!this.parseShiftHours(d.hours)){this.toast('근무 시작·끝 시각을 넣어 주세요 — 이 시간으로 앞뒤 근무 사이의 휴식을 잽니다','error',6000);return}
      try{await this.api('POST','/api/shifts',d)}catch(e){this.toast(e.message||'근무를 저장하지 못했습니다','error',6000);return}
      await this.loadShifts();this.shiftModal.open=false},
    async deleteShift(code){
      // V(연차)도 — 쉬는 칸을 V 로 채우는 병동이 지우면 생성이 막힌다 (2026-10-26, 서버 delete_shift 와 같은 목록)
      const PROTECTED=['DC','D','D1','EC','E','중','NC','N','OF','주','V'];
      if(PROTECTED.includes(code)){this.toast('기본 근무는 삭제할 수 없습니다','error');return}
      if(!confirm(`'${code}' 근무를 삭제하시겠습니까?`))return;await this.api('DELETE',`/api/shifts/${code}`);await this.loadShifts();
    },

    // ── 배점 관리 ─────────────────────────────────────────────
    async loadScoringRules(){this.scoringRules=await this.api('GET','/api/scoring_rules');this.loadScoringPresets()},
    // ── 배점 프리셋 (결정 1-78) — 지금 배점 규칙 전체를 이름 붙여 남긴다. 불러오기·기본값 되돌리기는 규칙 전체를 바꾸므로 한 번 확인한다 ──
    scoringPresets:[], scoringPresetPick:'', scoringPresetName:'',
    async loadScoringPresets(){try{const r=await this.api('GET','/api/scoring_presets');this.scoringPresets=Array.isArray(r)?r:[]}catch(e){this.scoringPresets=[]}
      if(!this.scoringPresets.some(p=>p.name===this.scoringPresetPick))this.scoringPresetPick=''},
    async saveScoringPreset(){
      const name=(this.scoringPresetName||'').trim();
      if(!name){this.toast('프리셋 이름을 적어 주세요','error');return}
      if(this.scoringPresets.some(p=>p.name===name)&&!confirm(`'${name}' 프리셋이 이미 있습니다. 지금 배점으로 덮어쓸까요?`))return;
      this.scoringPresets=await this.api('POST','/api/scoring_presets',{name});
      this.scoringPresetPick=name;this.scoringPresetName='';
      this.toast(`지금 배점을 '${name}' 프리셋으로 저장했습니다`,'success');
    },
    async applyScoringPreset(){
      const name=this.scoringPresetPick;if(!name)return;
      if(!confirm(`지금 배점을 '${name}' 프리셋으로 바꿉니다. 지금 배점은 저장해 두지 않았으면 사라집니다. 바꿀까요?`))return;
      this.scoringRules=await this.api('POST','/api/scoring_presets/apply',{name});
      this.toast(`'${name}' 프리셋을 불러왔습니다 — 다음 만들기부터 적용됩니다`,'success');
    },
    async deleteScoringPreset(){
      const name=this.scoringPresetPick;if(!name)return;
      if(!confirm(`'${name}' 프리셋을 지울까요? 지금 배점은 바뀌지 않습니다.`))return;
      this.scoringPresets=await this.api('POST','/api/scoring_presets/delete',{name});this.scoringPresetPick='';
    },
    async resetScoringRules(){
      if(!confirm('배점 규칙을 기본값으로 되돌립니다. 고친 점수·추가한 규칙은 프리셋으로 저장해 두지 않았으면 사라집니다. 되돌릴까요?'))return;
      this.scoringRules=await this.api('POST','/api/scoring_rules/reset');
      this.toast('배점 규칙을 기본값으로 되돌렸습니다','success');
    },
    scoringRuleTypeLabel(rt){return{transition:'전환 패턴',pattern:'N일 패턴',consecutive_same:'연속 동일',specific_shift:'특정 근무',wish:'희망 근무',night_fairness:'야간 공평성',weekend_fairness:'주말·공휴일 공평성',holiday_work:'공휴일 근무',weekend_work:'주말 근무',holiday_off:'공휴일 OFF'}[rt]||rt},
    scoringRuleCondSummary(r){
      const p=r.params||{};const gl=v=>({work:'모든근무',day:'낮',evening:'저녁',night:'야간',rest:'휴무',leave:'휴가',rest_leave:'휴무/휴가',non_night:'야간 아닌 날',any:'전체'})[v]||v;
      if(r.rule_type==='transition')return`${gl(p.from)} → ${gl(p.to)}`;
      if(r.rule_type==='pattern')return(p.pattern||[]).map(v=>({work:'근무',day:'낮',evening:'저녁',night:'야간',rest:'휴무',leave:'휴가',rest_leave:'휴무/휴가',non_night:'야간 아닌 날',any:'전체'})[v]||v).join(' → ');
      if(r.rule_type==='consecutive_same')return`연속 ${gl(p.period)} 쌍`;
      if(r.rule_type==='specific_shift')return`${p.shift_code||'-'}${p.condition==='female_only'?' (여성)':''}`;
      if(r.rule_type==='wish')return'희망 근무 매칭';
      if(r.rule_type==='night_fairness')return'야간 range 최소화 (+누적 3M)';
      if(r.rule_type==='weekend_fairness')return'주말·공휴일 근무 range 최소화 (+누적 3M)';
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
