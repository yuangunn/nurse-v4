/* ────────────────────────────────────────────────────────────────────────────
 * 리디자인 접착 모듈 (design/handoff) — 신호등 문장·단계 부제·상태 줄·실패 배너·서랍 탭·
 * 되돌리기 토스트·커스텀 툴팁·2단 확인·숫자 ±·셀 팝업 위치·인쇄 미리보기·폰 '내 근무'·
 * 서체 선택·검증용 상태 진입(window.__rdState)
 *
 * 원칙: 기존 핸들러(app.js·modules)는 그대로 두고 **문구와 배치만** 이 모듈이 계산한다.
 * 문구는 design/handoff/copy.json 을 그대로 쓴다 (의역 금지).
 * 사용: app() 반환 객체에 `...RedesignModule()` 로 스프레드.
 * ─────────────────────────────────────────────────────────────────────────── */
window.RedesignModule = function() {
  const WD = ['일','월','화','수','목','금','토'];
  const CODE_NAME = {DC:'Day Charge', D:'Day', D1:'상근·교육', EC:'Evening Charge', E:'Evening', '중':'중간번', NC:'Night Charge', N:'Night',
    OF:'오프', '주':'주휴', P1:'임부휴무', V:'연차', '생':'생리휴가', '특':'특별휴가', '공':'공적업무', '법':'법정공휴일', '병':'병가',
    '경가':'경사휴가', '조가':'조사휴가', '산전':'산전검진',
    'D/E':'낮·저녁', 'E/N':'저녁·야간', 'D/N':'낮·야간', 'D제외':'낮만 빼고', 'E제외':'저녁만 빼고', 'N제외':'야간만 빼고',
    'D/E/N':'쉬지만 않으면', 'D/OF':'낮 아니면 휴무', 'E/OF':'저녁 아니면 휴무', 'N/OF':'야간 아니면 휴무'};
  // 세부 원티드 — 그날 가능한 것(D 낮 · E 저녁 · N 야간 · R 휴무)을 켠 묶음이 곧 칸 코드다. 넷 다 켜면 빈칸(제한 없음), 하나만 켜면 기본 코드.
  // 묶음 코드의 뜻은 엔진 _FLEX_ONE_OF·_FLEX_NOT 과 같다
  const FINE = {DENR:'__CLEAR__', DEN:'D/E/N', DER:'N제외', DNR:'E제외', ENR:'D제외', DE:'D/E', EN:'E/N', DN:'D/N', DR:'D/OF', ER:'E/OF', NR:'N/OF', D:'D', E:'E', N:'N', R:'OF'};
  const WORK_ORDER = ['D','DC','D1','E','EC','중','N','NC'];
  const REST_ORDER = ['주','OF','V','생','특','공','법','병','경가','조가','P1','산전'];
  const PERIOD_KO = {D:'낮', E:'저녁', N:'야간'};
  // HiGHS 기록의 Src 글자(그 표를 어떻게 찾았는가)·끝난 상태를 쉬운 말로
  // ── 어떤 근무표를 원하세요? (결정 1-77) — 서로 맞바꾸는 배점끼리 '어느 쪽 우선'을 고른다. 고른 쪽의 배점을 곱해 요청에만 싣는다
  //    (설정의 우선순위 규칙 값은 그대로 — 손으로 고친 값 위에 곱한다). 가운데('mid')는 아무것도 곱하지 않는다.
  const is=(type, test)=>r=>r.rule_type===type && (!test || test(r.params||{}));
  const PREF_RULE = {
    singleN:  is('pattern', p=>(p.pattern||[]).join()==='non_night,night,non_night'),
    runN:     is('consecutive_same', p=>p.period==='night'),
    fairN:    is('night_fairness'),
    useV:     is('specific_shift', p=>p.shift_code==='V'),
    runRest:  is('consecutive_same', p=>p.period==='rest'),
    pongdang: is('pattern', p=>(p.pattern||[]).join()==='work,rest_leave,work'),
    juhuOff:  is('transition', p=>[p.from, p.to].sort().join()==='specific:OF,specific:주'),   // 주휴 옆에 OFF 붙이기 (결정 1-83) — 두 방향
    fairWk:   is('weekend_fairness'),
    wish:     is('wish'),
  };
  const PREF_AXES = [
    {id:'night', q:'야간 근무는', a:{label:'묶어서', kw:'야간 묶어서', hint:'하루짜리 야간을 줄이고 이틀·사흘씩 묶습니다', fx:{singleN:2, runN:2, fairN:0.5}},
                                  b:{label:'사람마다 고르게', kw:'야간 고르게', hint:'사람마다 야간 횟수 차이를 줄입니다', fx:{fairN:3, singleN:0.5}}},
    {id:'rest', q:'쉬는 날은', a:{label:'연차(V) 아끼기', kw:'연차 아끼기', hint:'자동으로 넣는 연차를 줄입니다', fx:{useV:2, runRest:0.5}},
                                b:{label:'연속 휴일 길게', kw:'연속 휴일 길게', hint:'쉬는 날을 붙여 주고 근무-휴무-근무를 줄입니다', fx:{runRest:3, pongdang:2, juhuOff:2, useV:0.5}}},
    {id:'weekend', q:'주말·공휴일은', a:{label:'근무를 고르게', kw:'주말 근무 고르게', hint:'사람마다 주말·공휴일 근무 횟수 차이를 줄입니다', fx:{fairWk:3, wish:0.5}},
                                      b:{label:'희망 근무 먼저', kw:'희망 근무 먼저', hint:'희망 근무(위시)를 더 들어줍니다. 원티드(사전입력)는 어느 쪽이든 지킵니다', fx:{wish:3, fairWk:0.5}}},
  ];
  // 여러 개 만들기(결정 1-86)의 방향 키워드 — 위 축의 양쪽 + 따로 둔 것. 두 키워드가 같은 배점을 건드리면(fx 의 이름이 겹치면) 함께 고르지 못한다
  const MAKE_KEYWORDS = [...PREF_AXES.flatMap(a=>['a','b'].map(s=>({id:a.id+'.'+s, label:a[s].kw, hint:a[s].hint, fx:a[s].fx}))),
    {id:'oneoff', label:'1오프 줄이기', hint:'OFF 를 주휴 옆에 더 세게 붙이고 근무-휴무-근무를 줄입니다', fx:{juhuOff:2, pongdang:2}}];
  const PREF_TIMES = [{v:20, label:'20분'}, {v:60, label:'60분'}, {v:'endless', label:'멈출 때까지 계속'}];
  const PREF_DEFAULT = {keys:[], time:20, quick:true};   // 하나만 만들 때의 선택 — 방향 키워드(MAKE_KEYWORDS 의 id) · 찾는 시간 · 초안 먼저
  const SRC = {B:'갈래를 나눠 따져 봄', C:'가운데 값에서 어림', F:'규칙을 맞추며 밀어 넣기', H:'어림 탐색', L:'작은 문제로 쪼개 풀기', P:'남은 것이 없는 문제', R:'무작위로 어림',
    S:'조건을 느슨하게 푼 답에서', T:'갈래를 평가하다가', U:'한계 없음', z:'가장 단순한 값으로', l:'가장 단순한 값으로', u:'가장 단순한 값으로', p:'가장 단순한 값으로'};
  const STATUS_KO = {'Optimal':'가장 좋은 표로 확인됨', 'Time limit reached':'시간이 다 됨', 'Interrupted by user':'멈춤', 'Infeasible':'이 조건으로는 만들 수 없음',
    'Solution limit reached':'정해 둔 만큼 찾음', 'Objective target reached':'목표 점수에 닿음'};
  // 솔버가 줄이는 값(감점) → 점수(높을수록 좋다). 'inf'·빈 값은 빈 글자
  const SCORE = v => (v==null||v===''||v==='inf'||isNaN(+v)) ? '' : Math.round(-(+v)).toLocaleString('ko-KR');
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtMD = dk => `${+dk.slice(5,7)}/${+dk.slice(8,10)}`;
  const fmtKo = dk => { const d = new Date(dk + 'T00:00:00'); return `${d.getMonth()+1}월 ${d.getDate()}일(${WD[d.getDay()]})`; };
  return {
    // ── 상태 ──
    drawerBig: false,            // 서랍을 화면 가운데 큰 창으로 (크게 보기)
    onb: {open:false, wait:''},  // 처음 시작 안내 창 — wait: 붙여넣기 창을 띄워 놓고 닫히기를 기다리는 단계
    onbTick: 0,                  // 안내 진행 표시(localStorage)를 바꾸면 올려 다시 그린다
    genFailed: false,            // 방금 한 만들기가 실패했다 — 앞 표가 떠 있어도 실패 배너·상태 줄로 알린다 (경고가 붙은 성공과 가른다)
    reportTab: 'summary',        // 서랍 탭: summary·relaxed·v·teukgeun·warn·wish·log
    showSolveEvents: false,      // 계산 현황의 '무슨 일이 있었나' — 기본은 최근 한 줄, 펼치면 전부
    showLiveLog: false,          // 만드는 중 원본 계산 기록 — 기본은 접고 해석한 계산 현황(rdSolveCards·solveStats.events)을 보인다
    solveStats: null,            // 솔버 기록에서 읽은 것 {phases:[{n,rows0,cols0,rows,cols,restarts,status,row}], events:[…]} (_solveFeed)
    story: {open:false, step:0}, // 결과 요약 — 생성이 끝나면 단계별로 넘겨 보는 창 (rdStorySteps)
    mk: {open:false, step:'count', count:'one', keys:[], time:20, quick:true},   // 만들기 마법사 (결정 1-93) — step: count·dir·time·run·cmp
    verLog: [], verCur: null, verSeen: 0,   // 표 기록 (결정 1-95) — 이번 만들기에서 나온 표들 [{n, sec, gap, result, payload, stats, screen}] · 화면의 번호 · 본 적 있는 가장 큰 번호
    verCmp: {on:false, a:null, saved:null, mode:'overlay', onlyChanged:false, dim:true, color:true, old:true, kinds:{rest:true, work:true, swap:true}},   // 견주기 — a: 견주는 앞 번호(화면의 표가 뒤) · saved: 번호 대신 저장한 근무표와 견줄 때 {id, name, schedule, stats}
    verNums: {open:false},       // '번호마다 숫자' 창
    solveOpen: false,            // 표가 떠 있는 채로 더 찾는 동안 계산 현황을 펼쳐 볼지 (기본은 한 줄)
    genFirst: null,              // 이번 만들기에서 처음 나온 표 — 더 찾은 표와 견준다 {schedule, extended_schedule, relaxed_cells, mip_gap_percent, sec}
    genPrefTick: 0,              // 저장한 선택을 다시 읽게 하는 값 (localStorage 는 반응하지 않는다)
    genEndless: false,           // 멈출 때까지 계속 — 한 번 끝날 때마다 그 표에서 다시 잇는다
    genRound: 1,                 // 이번 만들기의 몇 번째 찾기인가 (1 = 처음, 2부터 이어 찾기)
    genElapsedBase: 0,           // 앞 찾기들에 든 시간(초) — 이어 찾는 동안 걸린 시간을 처음부터 다시 세지 않는다
    genRounds: [],               // 끝난 찾기마다 {n, gap, improved, sec}
    storyHint: false,            // 요약을 중간에 닫은 직후 — 상태 줄 '결과 요약 다시 보기'를 잠깐 강조
    rdWhy: false,                // 원티드 미반영 탭에서 칸마다 그날 사정을 펼쳐 보인다 ('칸별 이유가 궁금하다면?')
    cellWhy: {},                 // 칸별 이유 — 'nid|날짜' → {loading} 또는 {res: 정밀 진단 결과} (rdCellWhy)
    rdToast: null,               // {msg, undo}
    _rdToastTimer: null,
    showPrintPreview: false,
    settingsSection: 'roster',   // roster·req·rules·shifts·scoring·misc
    ymEdit: false,
    myNurseId: localStorage.getItem('ns_my_nurse') || '',
    myOnly: false,
    rdMyPick: false,             // 폰 '내 근무' 카드의 이름 고르기 칩 열림
    fontPref: localStorage.getItem('ns_font') || '',
    rdConfirmKey: null, _rdConfirmTimer: null,
    signalPop: false,
    cellPop: {left: 0, top: 0},
    rdDoneAt: null, rdSaved: false,
    rdRelocked: {},              // "되돌려서 잠금" 누른 칸 — {nid|dk: true}
    rdFontOptions: [
      {v:'', label:'Pretendard (기본)'}, {v:'noto', label:'Noto Sans KR'}, {v:'nanum', label:'나눔고딕'},
      {v:'plex', label:'IBM Plex Sans KR'}, {v:'malgun', label:'맑은 고딕 (윈도우 기본)'},
    ],

    // ── 초기화 (프로필 열린 뒤 _initApp 끝에서) ──
    rdInit(){
      this.setFontPref(this.fontPref, true);
      this._rdTipInit();
      if(!window._rdPrintBound){ window._rdPrintBound = true;
        // 인쇄는 늘 차지 없이 D/E/N — 미리보기 없이 Ctrl+P 로 화면을 찍어도 같게
        window.addEventListener('beforeprint', () => { this._printPlain = true; if(this.showPrintPreview) document.body.classList.add('rd-printing'); });
        window.addEventListener('afterprint', () => { this._printPlain = false; document.body.classList.remove('rd-printing'); });
        document.addEventListener('scroll', () => { if(this.shiftEdit.open) this.rdPlacePopup(); }, true);
        document.addEventListener('mousedown', e => { if(!this.shiftEdit.open) return; const t=e.target; if(t.closest&&(t.closest('.rpop')||t.closest('[data-cell]')||t.closest('.modal-bg')||t.closest('.rmodal-bg'))) return; this.shiftEdit.open=false; }, true);
      }
    },
    setFontPref(v, silent){
      this.fontPref = v || '';
      if(this.fontPref) document.documentElement.dataset.font = this.fontPref; else delete document.documentElement.dataset.font;
      try { localStorage.setItem('ns_font', this.fontPref); } catch(e) {}
      if(!silent) this.toast('글꼴을 바꿨습니다', 'info');
    },

    // 셀 팝업이 열린 동안 키보드 입력 — 팝업 힌트('D E N V O 로 바로 입력 · Del 지우기')가 약속하는 동작.
    // 전역 keydown 은 팝업이 열리면 격자 입력을 건너뛰므로 여기서 같은 표를 쓴다 (단일·다중 선택 공용).
    rdPopupKey(e){
      const se=this.shiftEdit; if(!se.open||se.mode==='schedule') return;   // 여러 칸(prev_multi·sched_multi)은 받는다
      const t=document.activeElement; if(t&&(['INPUT','TEXTAREA','SELECT'].includes(t.tagName)||t.isContentEditable)) return;
      if(e.ctrlKey||e.metaKey||e.altKey) return;
      const apply=code=>{ e.preventDefault(); this.applyShiftEditWithUndo(code); };
      if(e.key==='Delete'||e.key==='Backspace') return apply('__CLEAR__');
      const key=(e.key||'').toUpperCase();
      const code={D:'D',E:'E',N:'N',V:'V',O:'OF',W:'주'}[key]||{'ㅈ':'주','ㅂ':'병','ㅃ':'법','ㅅ':'생','ㅌ':'특','ㄱ':'공','ㄲ':'경가','ㅉ':'조가','ㅆ':'산전'}[e.key]||(this.shifts.find(s=>s.code.toUpperCase()===key)||{}).code;
      if(code) apply(code);
    },

    // ── 공통 ──
    get rdWard(){ return (this.profiles||[]).find(p=>p.id===this.currentProfile)?.name || '게스트'; },
    // 당월 칸 수 — 신규는 트레이닝 날만 빼고 센다 (달 중간에 독립하면 그 뒤는 보통 간호사, 엔진과 같은 규칙)
    get rdCells(){
      const days=(this.scheduleDays||[]).filter(d=>!this.isOverflow(d));
      return (this.nurses||[]).reduce((a,n)=>a+(n.is_trainee?days.filter(d=>!this.isTraineeInTraining(n,d)).length:days.length), 0);
    },
    // 원티드 칸 수 — 표에서 분홍으로 칠하는 칸(isWanted)과 같다: 주휴·달 밖 날짜·지난달 표에서 이어온 첫 주기는 정해져 있는 칸이라 세지 않는다.
    // '몇 칸을 지켰다'는 말은 이 수로 한다 (단계 바의 'n칸 입력됨'은 넣은 칸 전부 — countPrevEntries)
    get rdWantedCount(){ let n=0; for(const nu of (this.nurses||[])) for(const d of (this.scheduleDays||[])) if(this.isWanted(nu.id,d)) n++; return n; },
    get rdWantedRelaxed(){ return (this.rdRelaxedList||[]).filter(x=>this.isWanted(x.nid, new Date(x.dk+'T00:00:00'))).length; },
    // 지키지 못한 신규의 트레이닝 날 사전입력 — 엔진은 넣은 '/' 휴무를 그대로, '/' 근무는 프리셉터를 그 근무로 끌고
    // 끝내 다르면 넣은 그대로 낸다(2026-10-19). 그래도 결과가 넣은 칸과 다르면 센다 (상태 줄이 '모두 지켰어요'라 하지 않게)
    get rdTraineeChanged(){
      if(!this.rdSched) return 0;
      let n=0;
      for(const nurse of (this.nurses||[])){
        if(!nurse.is_trainee) continue;
        const pre=this.prevSchedule?.[nurse.id]||{}, rx=this.relaxedCells?.[nurse.id]||{};
        for(const day of (this.scheduleDays||[])){
          if(!this.isTraineeInTraining(nurse,day)) continue;
          const dk=this.dayKey(day), p=pre[dk];
          if(rx[dk]) continue;   // 원티드 미반영(D/E 등)으로 이미 센 칸
          if(p && this.plainShift(this._getShift(nurse.id,day)||'')!==this.plainShift(p)) n++;
        }
      }
      return n;
    },
    // 보고 있는 달의 근무표가 있는가 — 달을 넘겨도 schedule 은 앞 달 것이 남아 있다. 앞뒤 달 표는 넘치는 주(이 달 1~6일·23일 이후)만 겹치므로 7~22일 칸으로 가린다
    get rdSched(){ const p=`${this.year}-${String(this.month).padStart(2,'0')}-`; return Object.values(this.schedule||{}).some(r=>Object.keys(r||{}).some(k=>k.startsWith(p) && k.slice(8)>='07' && k.slice(8)<='22')); },
    get rdRelaxedCount(){ return Object.keys(this.relaxedCells||{}).reduce((a,k)=>a+Object.keys(this.relaxedCells[k]||{}).length, 0); },
    rdCodeName(code){ const s=this.shiftMap.get(code); return CODE_NAME[code] || (s ? s.name : code); },
    rdShiftTip(code){
      const s=this.shiftMap.get(code); const name=this.rdCodeName(code);
      const hours=s && s.hours && s.hours!=='-' ? ' · '+s.hours : '';
      return `${name}${hours}`;
    },
    rdDayLabel(day){ return `${day.getMonth()+1}월 ${day.getDate()}일 (${WD[day.getDay()]})`; },
    rdFmtMD: fmtMD,
    rdWeekday(d){ return WD[d]; },
    rdEta(sec){ if(!sec) return '잠시'; return sec<90 ? `약 ${sec}초` : `약 ${Math.round(sec/60)}분`; },

    // ── 단계 바 부제 ("다음에 할 일") ──
    get rdStep(){
      const n=this.countPrevEntries();
      const sched=this.rdSched;
      let s3='만들고 인쇄';
      if(this.generating) s3='만드는 중…';
      else if(this.genFailed && !this.statusOk) s3='다시 만들기 실패';
      else if(this.rdPreChanged) s3='사전입력 바뀜 · 다시 만들어야 반영';
      else if(sched) s3=(this.rdRelaxedCount ? '완화로 생성' : '생성 완료')+(this.rdSaved ? ' · 저장됨' : '');   // 저장됨은 실제로 저장됐을 때만
      else if(!this.statusOk && this.statusMessage) s3='만들 수 없음';
      let s2='부족한 날 확인';
      if(this.analysisResult){ const danger=(this.analysisResult.warnings||[]).some(w=>w.type==='danger'); s2 = danger ? '부족한 날 있음' : '부족한 날 없음'; }
      return { gearDone: (this.nurses||[]).length>0, s1: n ? `${n}칸 입력됨` : '주휴·연차·희망 근무 넣기', s2, s3,
               done1: n>0, done2: !!this.analysisResult, done3: sched };
    },

    // ── 사전입력 신호등 한 줄 ──
    get rdSignal(){
      const n=this.countPrevEntries(true), total=this.rdCells;   // 분모와 같은 칸 — 이 달 칸, 신규 트레이닝 날 빼고
      if(!n) return {kind:'empty', dot:'none', text:'아직 비어 있어요 — 먼저 주휴를 넣거나', link:{label:'분석에서 주휴 추천 받기', act:'analysis'}};
      if((this.prevViolations||[]).length) return {kind:'fail', dot:'err', text:`이대로는 만들 수 없어요 — ${this.prevViolations[0].msg}`, link:{label:'자세히', act:'detail'}};
      const short=(this.staffingAlerts&&this.staffingAlerts.short)||[];
      if(short.length){
        const a=short[0];
        return {kind:'fail', dot:'err', text:`이대로는 만들 수 없어요 — ${fmtKo(a.dk)} 인원 ${a.needed-a.avail}명 부족`, link:{label:`${+a.dk.slice(8,10)}일 칸으로 가기`, act:'jump', dk:a.dk}};
      }
      const f=this.feas;
      if(f && f.checking && !f.status) return {kind:'checking', dot:'none', text:`만들 수 있는지 확인하는 중… · ${n} / ${total}칸 입력`, link:null};
      if(f && f.status==='infeasible'){
        // summary = 한 사람·한 날의 충돌을 날짜와 이미 넣은 휴무로 푼 한 줄 (라벨 하나만 보이면
        // '2주차 OF 2회'처럼 그 사람이 OF 를 두 번 넣은 것으로 읽힌다). focus = 문제가 시작되는 칸
        const a=f.focus||(f.anchored||[])[0];
        return {kind:'fail', dot:'err', text:`이대로는 만들 수 없어요 — ${f.summary || (a ? a.label : (f.message||''))}`, link: a ? {label:'칸으로 가기', act:'jumpA', a} : {label:'자세히', act:'detail'}};
      }
      const eta=f && f.estimated_seconds ? ` · 예상 ${this.rdEta(f.estimated_seconds)}` : '';
      if(f && f.status==='unknown') return {kind:'unknown', dot:'warn', text:`만들 수 있는지 5초 안에 판정하지 못했어요 (만들 때 확정) · ${n} / ${total}칸 입력`, link:null};
      if(f && f.status==='feasible') return {kind:'ok', dot:'ok', text:`지금 입력으로 만들 수 있어요${eta} · ${n} / ${total}칸 입력`, link:null};
      const tight=(this.staffingAlerts&&this.staffingAlerts.tight)||[];
      if(tight.length) return {kind:'tight', dot:'warn', text:`${fmtKo(tight[0].dk)}은 여유가 0명이에요. 휴가를 더 넣으면 부족해집니다. · ${n} / ${total}칸 입력`, link:null};
      return {kind:'ok', dot:'ok', text:`${n} / ${total}칸 입력`, link:null};
    },
    rdSignalAct(link){
      if(!link) return;
      if(link.act==='analysis') this.activeTab='analysis';
      else if(link.act==='jump') this.jumpToPreCell(null, link.dk);
      else if(link.act==='jumpA') this.jumpToPreCell(link.a.nurse_id, link.a.date);
      else if(link.act==='detail') this.signalPop=!this.signalPop;
    },
    get rdSignalDetailCount(){
      return (this.prevViolations||[]).length + (this.prevPinNotes||[]).length + (((this.feas||{}).anchored)||[]).length + (((this.staffingAlerts||{}).short)||[]).length;
    },

    // ── 근무표 상태 줄 ──
    get rdStatus(){
      if(this.generating){
        const rem=this.estimatedSeconds ? Math.max(0, this.estimatedSeconds-this.generateElapsed) : 0;
        const t = rem ? this.rdEta(rem)+' 남음' : (this.estimatedSeconds ? '예상보다 오래 걸리지만 멈춘 게 아니에요' : '잠시만요');
        if(this.continuing){   // 이어 찾기 (결정 1-50) — 앞 표는 저장돼 있고 화면에 그대로다
          const g=this.mipGapPercent;
          return {kind:'warn', running:true, text:`지금 표는 저장했어요${g!=null?` (가장 좋은 답과 ${Math.round(g*10)/10}% 차이)`:''} · 그 표에서 더 좋은 표를 찾는 중 (${Math.max(1,this.genRound-1)}번째 이어 찾기)… ${this.genEndless?'멈출 때까지 계속 찾습니다':t} · 멈추면 지금 표를 씁니다`};
        }
        return {kind:'warn', running:true, text:`근무표를 만드는 중… ${t}`};
      }
      if(!this.rdSched) return null;
      if(this.genFailed && !this.statusOk) return {kind:'err', failed:true, text:'다시 만들지 못했어요 — 표는 그 전에 만든 표 그대로입니다. 바로 아래 안내에서 원인을 확인하세요'};
      if(this.rdPreChanged) return {kind:'warn', changed:true, text:'사전입력을 고친 뒤 아직 다시 만들지 않았어요 — 지금 표는 고치기 전 사전입력으로 만든 것입니다'};
      const rx=this.rdRelaxedCount;
      const pre=this.rdWantedCount;
      // gap(최적해와의 거리) 문장 — CP-SAT 가능해는 gap 이 수천 % 도 나오므로 숫자는 10% 안쪽일 때만 보여 준다
      const g=this.mipGapPercent;
      const q = this.scheduleStopped ? ' · 중간에 멈춰 지금까지 찾은 답' : (g==null ? '' : (g<=0.1 ? ' · 가장 좋은 답' : (g<=10 ? ` · 가장 좋은 답과 ${Math.round(g*10)/10}% 안쪽 차이` : ' · 시간 안에 찾은 답 (더 좋은 표가 있을 수 있어요)')));
      const at=this.rdDoneAt instanceof Date ? ` (${this.rdDoneAt.getMonth()+1}월 ${this.rdDoneAt.getDate()}일 ${String(this.rdDoneAt.getHours()).padStart(2,'0')}:${String(this.rdDoneAt.getMinutes()).padStart(2,'0')})` : '';
      const saved = this.rdSaved ? '만들어졌고 저장됐습니다' : '만들어졌습니다';
      // 신규의 트레이닝 날 칸은 완화가 아니라 프리셉터 근무를 따라 바뀐다 — relaxedCells 에 없으니 따로 센다
      const tc=this.rdTraineeChanged;
      const tcNote=tc ? ` · 신규 트레이닝 날 ${tc}칸은 프리셉터 근무를 따랐어요` : '';
      if(rx) return {kind:'ok', relaxed:true, text:`근무표가 ${saved}${at} · 사전입력 ${rx}칸을 바꿔서 만들었어요${tcNote}${q}`};
      if(!this.statusOk && this.statusMessage) return {kind:'warn', text:`근무표는 있지만 확인이 필요해요 — 아래 요약·리포트의 생성 기록을 보세요`};
      if(tc) return {kind:'ok', text:`근무표가 ${saved}${at} · 원티드 ${Math.max(pre-tc,0)}칸 지켰어요${tcNote}${q}`};
      return {kind:'ok', text:`근무표가 ${saved}${at} · 원티드 ${pre}칸 모두 지켰어요${q}`};
    },
    // 만드는 중 진행 한 줄 — solveProgress(SSE progress, 1초마다). 차이 숫자는 상태 줄과 같은 규칙(10% 안쪽만),
    // 3분 넘게 나아지지 않으면 멈춰도 된다고 알린다 (v4.12 '생성 중' 카드의 'n분째 개선 없음')
    get rdLiveProgress(){
      const p=this.solveProgress||{};
      if(p.has_solution){
        const g=p.gap_percent;
        const q = g==null||g>10 ? '더 좋은 답을 찾는 중' : (g<=0.1 ? '가장 좋은 답이에요 · 마무리하는 중' : `가장 좋은 답과 ${Math.round(g*10)/10}% 안쪽 차이`);
        const st=(p.stalled_seconds||0)>=180 ? ` · ${Math.floor(p.stalled_seconds/60)}분째 나아지지 않음 — 지금 멈춰도 됩니다` : '';
        return `답을 찾았어요 · ${q}${st}`;
      }
      if((p.nodes||0)>0) return `답을 찾는 중 · ${p.nodes.toLocaleString('ko-KR')}가지 경우를 따져 봤어요`;
      return '조건을 정리하는 중';
    },
    get rdEdited(){ return this._originalSchedule ? this.getManualEditCount() : 0; },

    // ── 처음 시작 안내 (결정 1-71) — 새 병동은 번표 붙여넣기부터: 예시 명부 지우기 → 지난달 근무표 → 이번 달 사전입력 →
    //    명부 확인 → 필요 인원 확인 → 만들기. 끝낸 단계는 자료를 보고 판정하고(붙여넣은 표·사전입력·만든 표), 눈으로 확인하는
    //    두 단계와 건너뛰기·끝내기만 병동마다 localStorage('ns_onb:<병동>')에 적는다. 예시 명부(이름 앞 *)가 있는 새 병동에서 저절로 뜬다 ──
    onbFlags(){ try{ return JSON.parse(localStorage.getItem('ns_onb:'+(this.currentProfile||''))||'{}')||{}; }catch(e){ return {}; } },
    onbSet(k, v){ const f=this.onbFlags(); f[k]=v; try{ localStorage.setItem('ns_onb:'+(this.currentProfile||''), JSON.stringify(f)); }catch(e){} this.onbTick++; },
    onbCheck(){
      const f=this.onbFlags(); if(f.done) return false;
      if(!f.started && !(this.nurses||[]).some(n=>String(n.name||'').startsWith('*'))) return false;   // 쓰던 병동에는 띄우지 않는다
      if(!f.started) this.onbSet('started', 1);
      this.onb.open=true; return true;
    },
    onbStart(){ this.onbSet('done', 0); this.onbSet('started', 1); this.onb={open:true, wait:''}; },   // 도움말에서 다시 열기
    get rdOnbActive(){ this.onbTick; const f=this.onbFlags(); return !!this.currentProfile && !this.profileScreen && !!f.started && !f.done; },
    get rdOnbSteps(){
      this.onbTick; const f=this.onbFlags();
      const seed=(this.nurses||[]).filter(n=>String(n.name||'').startsWith('*')).length;
      const pd=new Date(this.year, this.month-2, 1), py=pd.getFullYear(), pm=pd.getMonth()+1;
      const hasLast=(this.savedSchedules||[]).some(s=>s.year===py&&s.month===pm), pre=this.countPrevEntries(true)>0;
      const steps=[];
      if(seed || f.seed) steps.push({id:'seed', title:'예시 명부 지우기', act:'예시 간호사 지우기', done:!seed,
        desc:`새 병동에는 예시 간호사 ${seed||''}명이 들어 있습니다(이름 앞 *). 우리 병동 사람을 넣기 전에 지웁니다.`});
      steps.push({id:'last', title:`${pm}월 근무표 붙여넣기`, act:'근무표 붙여넣기', skip:true, done:hasLast||!!f.last, skipped:!hasLast&&f.last==='skip',
        desc:'엑셀 번표를 복사해 붙여넣거나 파일을 올립니다. 명부에 없는 이름은 ‘간호사로 추가하고 다시 맞추기’를 누르면 명부가 만들어지고, 주휴 요일과 지난달 야간 수를 이어받습니다.'});
      steps.push({id:'pre', title:`${this.month}월 사전입력 붙여넣기`, act:'사전입력 붙여넣기', skip:true, done:pre||!!f.pre, skipped:!pre&&f.pre==='skip',
        desc:'원티드·주휴·휴가가 든 표를 붙여넣습니다. 표에서 칸을 눌러 직접 넣어도 됩니다.'});
      steps.push({id:'roster', title:'명부 확인', act:'명부 열기', confirm:true, done:!!f.roster,
        desc:'붙여넣은 표로는 알 수 없는 것을 확인합니다 — 할 수 있는 근무(차지·야간), 야간전담 달, 임산부, 순서(위가 선임).'});
      steps.push({id:'req', title:'필요 인원 확인', act:'필요 인원 열기', confirm:true, done:!!f.req,
        desc:'요일별 D·E·N 인원과, 공휴일처럼 그 날만 다른 인원을 확인합니다.'});
      steps.push({id:'make', title:'근무표 만들기', act:'근무표 만들기', done:!!this.rdSched,
        desc:'사전입력을 지키면서 나머지 칸을 자동으로 채웁니다.'});
      return steps;
    },
    get rdOnbNext(){ return this.rdOnbSteps.findIndex(s=>!s.done); },
    async rdOnbDo(id){
      if(id==='seed'){
        for(const n of (this.nurses||[]).filter(x=>String(x.name||'').startsWith('*'))) await this.api('DELETE', `/api/nurses/${n.id}`);
        await this.loadNurses(); this.onbSet('seed', 1); return;
      }
      this.onb.open=false;
      if(id==='last'){ this.onb.wait='last'; this.activeTab='schedule'; this.openPastePrev('saved'); }
      else if(id==='pre'){ this.onb.wait='pre'; this.activeTab='preinput'; this.openPastePrev(); }
      else if(id==='roster'){ this.activeTab='settings'; this.settingsSection='roster'; }
      else if(id==='req'){ this.activeTab='settings'; this.settingsSection='req'; }
      else if(id==='make'){ this.rdGoMake(); }
    },
    // 붙여넣기 창이 닫히면 안내 창으로 돌아온다
    // 근무표를 올리면 '저장한 근무표' 창이 뒤따라 열린다 — 안내 창을 덮지 않게 닫는다
    rdOnbBack(){
      if(this.onb.wait && !(this.pastePrev&&this.pastePrev.open)){ this.onb.wait=''; if(this.rdOnbActive) this.onb.open=true; }
      if(this.onb.open && this.rdOnbActive && this.showSavedDrawer) this.showSavedDrawer=false;
    },

    // ── 계산 현황 — 솔버(HiGHS) 기록을 줄 단위로 읽어 숫자와 사건으로 (결정 1-64) ──
    // 화면에 남기는 기록(solverLogs)은 최근 200줄로 잘리므로, 줄이 들어올 때마다 여기에 쌓는다. 한 번의 생성에 풀이(Presolving model)가
    // 여러 번 올 수 있다(완화 단계). CP-SAT 기록은 형식이 달라 읽지 않는다 — 카드는 진행 정보(solveProgress)의 노드·Gap 만 보인다.
    _solveReset(){ this.solveStats={phases:[], events:[], seq:0, found:0}; },
    _pushLog(msg, hint){
      this.solverLogs.push(hint ? {id:++this._logSeq, msg, hint:true} : {id:++this._logSeq, msg});
      if(!hint){ if(this.solverLogs.length>300) this.solverLogs=this.solverLogs.slice(-200); for(const l of String(msg).split('\n')) this._solveFeed(l); }   // 한 메시지에 여러 줄이 온다
      this._scrollLogs();
    },
    _solveFeed(line){
      if(!this.solveStats) this._solveReset();
      const S=this.solveStats, n=x=>Number(x).toLocaleString('ko-KR'); let P=S.phases[S.phases.length-1], m;
      const score=SCORE;
      const ev=text=>{ const r=(P&&P.row)||{}; S.events.push({id:++S.seq, solve:S.phases.length, time:r.time??0, text, nodes:r.proc??0, sol:score(r.sol), gap:r.gap&&r.gap!=='inf'?r.gap:''}); if(S.events.length>200) S.events.splice(0, S.events.length-200); };
      line=String(line??'');
      if(/^Presolving model/.test(line)){ S.phases.push({n:S.phases.length+1, rows0:null, cols0:null, rows:null, cols:null, restarts:0, status:'', row:null, start:null, had:false}); return; }
      if(!P) return;
      if((m=line.match(/^(\d+) rows, (\d+) cols, \d+ nonzeros/))){ if(P.rows0==null){ P.rows0=+m[1]; P.cols0=+m[2]; } P.rows=+m[1]; P.cols=+m[2]; return; }
      if((m=line.match(/^MIP start solution is feasible, objective value is (\S+)/))){ P.start=m[1]; P.had=true; ev('앞 단계에서 찾은 표로 시작'); return; }
      if(/^Solving MIP model with/.test(line)){ if(P.rows0!=null) ev(`조건 정리 — 따질 조건 ${n(P.rows0)}개를 ${n(P.rows)}개로 줄임`); return; }
      if((m=line.match(/^([\d.]+)% inactive integer columns, restarting/))){ P.restarts++; P.inactive=m[1]; return; }
      if((m=line.match(/^Model after restart has (\d+) rows, (\d+) cols/))){ ev(`문제를 줄여 다시 시작 — 더 볼 필요 없는 칸 ${P.inactive}%를 걷어 냄 (조건 ${n(m[1])}개)`); return; }
      // 큰 수는 솔버가 '2237k'·'1.2M' 처럼 줄여 적는다 — 숫자 칸마다 받아 풀어 읽는다 (못 읽으면 그 줄부터 카드가 멈춘다)
      if((m=line.match(/^\s*([A-Za-z])?\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d.]+)%\s+(\S+)\s+(\S+)\s+(\S+)\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d.]+[kMG]?)\s+([\d.]+)s\s*$/))){
        const num=v=>Math.round(parseFloat(v)*({k:1e3,M:1e6,G:1e9}[v.slice(-1)]||1));
        const row={src:m[1]||(P.row&&P.row.src)||'', proc:num(m[2]), queue:num(m[3]), leaves:num(m[4]), expl:+m[5], bound:m[6], sol:m[7], gap:m[8], cuts:num(m[9]), inlp:num(m[10]), confl:num(m[11]), lpit:num(m[12]), time:+m[13]};
        const better=row.sol!=='inf' && row.sol!==(P.row ? P.row.sol : P.start);
        P.row=row;
        if(better){ ev(`${P.had?'더 좋은 표를 찾음':'첫 표를 찾음'}${m[1]&&SRC[m[1]]?` — ${SRC[m[1]]}`:''}`); P.had=true; S.found=(S.found||0)+1; }
        return;
      }
      if((m=line.match(/^\s+Status\s+(.+)$/))){ P.status=m[1].trim(); ev(`끝 — ${STATUS_KO[P.status]||P.status}`); }
    },
    // 숫자 카드 — 지금 풀이의 마지막 줄을 쉬운 말로. 솔버가 줄이는 값은 점수의 음수라 부호를 뒤집어 '점수'(높을수록 좋다)로 보인다.
    // 솔버 기록의 원래 이름(Proc.·Leaves·BestSol…)은 툴팁에만 둔다
    get rdSolveCards(){
      const S=this.solveStats, P=S&&[...S.phases].reverse().find(p=>p.row), n=x=>Number(x).toLocaleString('ko-KR');
      if(!P){
        const p=this.solveProgress||{}; if(!(p.nodes>0) && p.gap_percent==null) return [];
        return [{k:'따져 본 경우', v:n(p.nodes||0), tip:'지금까지 따져 본 경우의 수'}, {k:'가능한 최고와의 차이', v:p.gap_percent==null?'—':(Math.round(p.gap_percent*100)/100)+'%', tip:'지금 표가 이론상 가장 좋은 표와 얼마나 차이 나는지 — 0%면 가장 좋은 표'}];
      }
      const r=P.row;
      return [
        {k:'따져 본 경우', v:n(r.proc), tip:'지금까지 끝까지 따져 본 경우의 수 (솔버 기록의 Proc.)'},
        {k:'아직 남은 경우', v:n(r.queue), tip:'더 따져 봐야 해서 줄 서 있는 경우의 수 (InQueue)'},
        {k:'쳐낸 경우', v:n(r.leaves), tip:'더 볼 필요가 없어 닫은 경우의 수 — 가망이 없거나 이미 답이 나온 갈래 (Leaves)'},
        {k:'살펴본 비율', v:r.expl+'%', tip:'전체 경우 가운데 살펴본 비율 (Expl.)'},
        {k:'지금 표 점수', v:SCORE(r.sol)||'—', tip:'지금까지 찾은 가장 좋은 표의 점수 — 높을수록 좋다 (BestSol 의 부호를 뒤집은 값)'},
        {k:'가능한 최고 점수', v:SCORE(r.bound)||'—', tip:'어떤 표도 이 점수를 넘을 수 없다는 한계 (BestBound)'},
        {k:'최고와의 차이', v:r.gap==='inf'?'—':r.gap, tip:'지금 표 점수와 가능한 최고 점수의 차이 — 0%면 가장 좋은 표 (Gap)'},
        {k:'방금 표를 찾은 방법', v:(r.src&&SRC[r.src])||'—', tip:'가장 최근 표를 어떻게 찾았는지 (Src '+(r.src||'-')+')'},
      ];
    },
    get rdSolveSub(){
      const S=this.solveStats, P=S&&S.phases[S.phases.length-1], n=x=>Number(x).toLocaleString('ko-KR'); if(!P) return '';
      const r=P.row;
      return `${P.n}번째 풀이` + (P.rows0!=null ? ` · 따질 조건 ${n(P.rows0)}개를 ${n(P.rows)}개로 정리` : '') + (P.restarts ? ` · 문제를 줄여 다시 시작 ${P.restarts}번` : '')
        + (r ? ` · 새로 찾아 더한 규칙 ${n(r.cuts)}개 · 막힌 데서 배운 것 ${n(r.confl)}개 · 계산 ${n(r.lpit)}번` : '') + (P.status ? ` · ${STATUS_KO[P.status]||P.status}` : '');
    },
    get rdSolveEvents(){ return [...((this.solveStats&&this.solveStats.events)||[])].reverse(); },   // 새 것이 위

    // ── 결과 요약 — 생성이 끝나면 한 장씩 넘겨 본다: 계산 → 지킨 것 → 바꾼 것 → 확인할 것 → 결과 (결정 1-64) ──
    rdStoryOpen(){ this.story={open:true, step:0}; this.storyHint=false; },
    rdStoryGo(d){ const last=this.rdStorySteps.length-1, s=this.story.step+d; if(s>last){ this.story.open=false; return; } this.story.step=Math.max(0, s); },
    // 끝까지 보기 전에 닫으면 다시 여는 자리를 알린다 — 창 밖을 눌러서는 닫히지 않는다 (같은 자리의 '다음'을 연달아 누르다 닫히는 일이 없게)
    rdStoryClose(){
      const early=this.story.step<this.rdStorySteps.length-1; this.story.open=false; if(!early) return;
      this.storyHint=true; setTimeout(()=>{ this.storyHint=false; }, 6000);
      this.toast('결과 요약은 표 위 상태 줄의 ‘결과 요약 다시 보기’에서 다시 볼 수 있어요','info',6000);
    },
    rdStoryKey(e){ if(!this.story.open) return; if(e.key==='Escape') this.rdStoryClose(); else if(e.key==='ArrowRight'||e.key==='Enter'){ e.preventDefault(); this.rdStoryGo(1); } else if(e.key==='ArrowLeft') this.rdStoryGo(-1); },
    get rdStoryStep(){ const s=this.rdStorySteps; return s[Math.min(this.story.step, s.length-1)]||null; },
    get rdStorySteps(){
      if(!this.rdSched) return [];
      const n=x=>Number(x).toLocaleString('ko-KR'), steps=[];
      const ph=((this.solveStats&&this.solveStats.phases)||[]).filter(p=>p.row), sum=k=>ph.reduce((a,p)=>a+(p.row[k]||0), 0), lastP=ph[ph.length-1];
      // 이어 찾았으면 처음부터 든 시간 — 마지막 찾기 것만 보이면 처음부터 다시 찾은 것처럼 읽힌다
      const total=(this.genElapsedBase||0)+(this.generating ? (this.generateElapsed||0) : (this.generateFinalElapsed||0));
      const sec=Math.round((this.genRound>1 && total) || (this.generationReport&&this.generationReport.duration_seconds) || sum('time') || 0);
      const dur=sec>=60 ? `${Math.floor(sec/60)}분 ${sec%60}초` : `${sec}초`;
      const g=this.mipGapPercent;
      const calc=[];
      if(sec) calc.push([this.generating ? '지금까지 걸린 시간' : '걸린 시간', dur]);
      if(this.genRound>1) calc.push(['이어 찾기', `${this.genRound-1}번`]);
      if(this.solveStats&&this.solveStats.found) calc.push(['찾은 표', `${n(this.solveStats.found)}개`]);
      if(ph.length){
        calc.push(['풀이 횟수', `${ph.length}번`], ['따져 본 경우', `${n(sum('proc'))}가지`], ['더 볼 필요 없어 쳐낸 경우', `${n(sum('leaves'))}가지`], ['계산 횟수', `${n(sum('lpit'))}번`]);
        if(ph[0].rows0!=null) calc.push(['따질 조건 정리', `${n(ph[0].rows0)}개 → ${n(ph[0].rows)}개`]);
        if(lastP.row.src&&SRC[lastP.row.src]) calc.push(['마지막 표를 찾은 방법', SRC[lastP.row.src]]);
        if(lastP.status) calc.push(['끝난 까닭', STATUS_KO[lastP.status]||lastP.status]);
      }
      if(g!=null) calc.push(['가능한 최고와의 차이', (Math.round(g*100)/100)+'%']);
      else if(lastP && lastP.row.gap!=='inf') calc.push(['가능한 최고와의 차이', lastP.row.gap]);
      steps.push({id:'calc', eyebrow:'계산', title: ph.length ? `경우 ${n(sum('proc'))}가지를 따져 봤어요` : '근무표를 계산했어요',
        sub: (this.generating&&this.continuing) ? '지금도 더 좋은 표를 찾고 있어요. 아래는 지금 화면에 있는 표의 것입니다.' : this.scheduleStopped ? '중간에 멈춰 그때까지 찾은 표입니다.' : (g==null ? '' : (g<=0.1 ? '이 조건에서 가장 좋은 표입니다.' : `가장 좋은 표와 ${Math.round(g*10)/10}% 안쪽 차이에서 멈췄습니다.`)), facts:calc});
      // 초안과 견주기 — 더 찾아서 표가 바뀌었을 때만
      const dc=this.rdDraftCmp;
      if(dc){ const fs=v=>v==null ? '—' : v, t0=dc.sec>=60 ? `${Math.floor(dc.sec/60)}분 ${dc.sec%60}초` : `${dc.sec}초`;
        steps.push({id:'draft', eyebrow:'처음 표와 견주기', title: dc.better ? `처음 표보다 ${dc.better}가지가 나아졌어요` : '처음 표와 숫자는 비슷해요',
          sub:`처음 표는 ${t0} 만에 나왔고, 그 뒤 더 찾아 바꾼 것이 지금 표입니다. 숫자는 모두 작을수록 좋습니다.${dc.worse ? ' 점수 전체로는 나아졌지만 나빠진 항목도 있습니다.' : ''}`,
          facts:[['달라진 칸', `${dc.cells}칸 · ${dc.who}명`]],
          // 표로 — 견주는 것 · 처음 표 · 지금 표 · 변화 (한 줄 글보다 눈으로 훑기 쉽다)
          table:{head:['견주는 것', '처음 표', '지금 표', '변화'], rows:dc.rows.map(r=>({label:r.label, tip:r.tip, a:fs(r.a), b:fs(r.b),
            word:(r.a==null||r.b==null||r.a===r.b) ? '그대로' : (r.b<r.a ? '나아짐' : '나빠짐'), tone:(r.a==null||r.b==null||r.a===r.b) ? '' : (r.b<r.a ? 'good' : 'bad')}))}}); }
      const pre=this.rdWantedCount, rx=this.rdRelaxedCount, tc=this.rdTraineeChanged, keptN=Math.max(pre-this.rdWantedRelaxed-tc, 0);
      // 표 아래 '배정 / 필요' 줄과 같은 셈 — 날짜별로 고친 필요 인원(rdFootNeed)과 견준다
      const rowsDEN=(this.footerRows||[]).filter(r=>['D','E','N'].includes(r.label));
      const short=this.scheduleDays.filter(d=>!this.isPrevMonthDay(d)).reduce((a,d)=>a+rowsDEN.filter(r=>this.getDayDutyCount(d,r.shifts)<(+this.rdFootNeed(d,r.label)||0)).length, 0);
      const kept=[['원티드 (주휴·지난달 표에서 이어온 칸은 빼고)', `${n(pre)}칸`], ['그대로 지킨 칸', `${n(keptN)}칸`]];
      if(tc) kept.push(['신규 트레이닝 날 (프리셉터 근무를 따름)', `${tc}칸`]);
      kept.push(['날마다 필요 인원 (D·E·N)', short ? `${short}곳 모자람` : '모두 채움']);
      steps.push({id:'kept', eyebrow:'지킨 것', title: keptN<pre ? `원티드 ${n(pre)}칸 중 ${n(keptN)}칸을 지켰어요` : `원티드 ${n(pre)}칸을 모두 지켰어요`, sub:'', facts:kept});
      if(rx) steps.push({id:'changed', eyebrow:'바꾼 것', title:`${rx}칸은 바꿀 수밖에 없었어요`, sub:'바꾸면 안 되는 칸은 되돌려서 잠금을 누른 뒤 다시 만들어 보세요.', facts:[]});
      const chk=(this.scheduleWarnings||[]).filter(w=>w.type==='check').length, ot=(this.offTeukgeun||[]).length, v=(this.vReport&&this.vReport.total)||0;
      const wr=this.wishReport, unmet=wr ? Math.max(0,(wr.total_requested||0)-(wr.total_granted||0)) : 0;
      const check=[];
      if(chk) check.push(['파트장 확인 필요 (연속 근무 한도+1 · E→D1 · 중→D)', `${chk}건`, 'warn']);
      if(ot) check.push(['오프특근 (주 1회 OFF 반납)', `${ot}건`, 'teukgeun']);
      if(v) check.push(['자동으로 넣은 연차 (V)', `${v}건`, 'v']);
      if(unmet) check.push(['못 들어간 희망 근무', `${unmet}건`, 'wish']);
      if(check.length) steps.push({id:'check', eyebrow:'확인할 것', title:`확인할 것이 ${check.length}가지 있어요`, sub:'줄을 누르면 근무표 아래 리포트의 그 탭이 열립니다.', facts:check});
      steps.push({id:'done', eyebrow:'결과', title:(this.generating&&this.continuing) ? '지금 표는 이렇습니다' : '근무표가 준비됐어요',
        sub:(this.generating&&this.continuing) ? '더 좋은 표가 나오면 바꿔 저장합니다. 멈추면 지금 표를 그대로 씁니다.' : (this.rdSaved ? '자동으로 저장했습니다.' : ''), facts:[]});
      return steps;
    },
    // 칸별 이유 — "이 칸을 지켰다면?" 이 칸만 원래 사전입력으로 두고(다른 바뀐 칸은 풀어 둔 채) 정밀 진단(/api/diagnose)을 돌린다.
    // 만든 표가 규칙을 지키므로, 여기서 막히면 그 칸을 지킨 탓이다 — 부딪히는 규칙 묶음이 그 칸의 이유.
    // 막히지 않으면 지킬 수 있는 칸(계산을 멈췄거나 시간 안에 못 찾은 것). 진단은 길면 1분 (결정 1-66)
    async rdCellWhy(nid, dk){
      const key=nid+'|'+dk, info=this.relaxedCells?.[nid]?.[dk];
      if(!info || (this.cellWhy[key]||{}).loading) return;
      const prev=JSON.parse(JSON.stringify(this.prevSchedule||{}));
      for(const [n,cells] of Object.entries(this.relaxedCells||{})) for(const d of Object.keys(cells||{})) if(prev[n]) delete prev[n][d];
      (prev[nid]=prev[nid]||{})[dk]=info.original;
      this.cellWhy={...this.cellWhy, [key]:{loading:true}};
      let res;
      try{ res=await this.api('POST','/api/diagnose',{...this._diagPayload(), prev_schedule:prev}); }
      catch(e){ res={status:'error', message:'계산하지 못했습니다'+(e&&e.message?` — ${e.message}`:'')}; }
      this.cellWhy={...this.cellWhy, [key]:{res:res||{status:'error', message:'계산하지 못했습니다'}}};
    },
    // 화면에 그릴 모양 — null(아직 안 눌렀다) · loading · free(지킬 수 있는 칸) · blocked(부딪히는 규칙 묶음, 줄마다 갈 칸) · unknown(시간 초과 등)
    rdCellWhyView(nid, dk){
      const w=this.cellWhy[nid+'|'+dk]; if(!w) return null;
      if(w.loading) return {state:'loading', groups:[]};
      const r=w.res||{}, by=new Map((r.anchored||[]).map(a=>[a.label,a]));
      const sets=(r.muses&&r.muses.length) ? r.muses : ((r.conflicts&&r.conflicts.length) ? [r.conflicts] : []);
      if(sets.length) return {state:'blocked', groups:sets.map(m=>m.map(l=>by.get(l)||{label:l, nurse_id:null, date:null})),
        soft: !!((this.offTeukgeun||[]).length || (this.managerCheck||[]).length)};
      return {state: r.status==='feasible' ? 'free' : 'unknown', groups:[], message:r.message||''};
    },
    // 그날 사정 — 그날 근무할 수 있는 사람이 필요 인원보다 모자랐는가 (사전입력 기준 산술, 인원 여유 검사 _checkStaffing 과 같은 셈).
    // 인원이 모자란 날만 '풀 수밖에 없는 날'이라고 말한다 — 어느 규칙과 부딪혔는지는 '이 칸을 지키면?'(rdCellWhy)이 따져 본다
    rdDayFacts(dk){
      const day=new Date(dk+'T00:00:00'), need=['D','E','N'].reduce((a,c)=>a+(+this.rdFootNeed(day,c)||0), 0);
      let on=0, rest=0;
      for(const nu of this.nurses){
        if(this.isNurseInactive(nu,day) || (nu.is_trainee&&this.isTraineeInTraining(nu,day))) continue;
        on++;
        const p=(this.shiftMap.get((this.relaxedCells?.[nu.id]?.[dk]?.original)||this.prevSchedule[nu.id]?.[dk]||'')||{}).period;
        if(p==='rest'||p==='leave') rest++;
      }
      const can=on-rest, short=Math.max(0, need-can);
      return {need, on, rest, can, short, text: short
        ? `그날 사정 — 재적 ${on}명 중 ${rest}명이 쉬는 날로 들어 있어 근무할 수 있는 사람이 ${can}명, 필요 인원은 ${need}명입니다. ${short}명이 모자라 쉬는 날 원티드 ${short}칸은 풀 수밖에 없는 날이었습니다.`
        : can===need
        ? `그날 사정 — 근무할 수 있는 사람(${can}명)이 필요 인원(${need}명)과 딱 맞아 여유가 없는 날이었습니다. 야간전담·임산부처럼 그날 설 수 있는 근무가 정해진 사람이 있으면 쉬는 날 원티드를 풀어야 할 수 있습니다.`
        : `그날 사정 — 사람 수만 보면 ${can-need}명 여유가 있었습니다 (필요 ${need}명 · 근무할 수 있는 사람 ${can}명). 인원이 아닌 다른 규칙(연속 근무·야간 뒤 휴무·차지 등)과 부딪혔을 수 있습니다.`};
    },

    // ── 실패 배너 ──
    // 보고 있는 달의 저장본 중 가장 새것 (목록은 새것부터) — 앱을 다시 열면 표는 비어 있고 저장본만 남는다
    get rdSavedThisMonth(){ return (this.savedSchedules||[]).find(sv=>sv.year===this.year&&sv.month===this.month)||null; },
    get rdFail(){
      // 표가 떠 있으면 숨긴다(경고가 붙은 성공도 statusOk=false 다) — 단, 방금 다시 만들기가 실패했으면 앞 표 위에 그대로 알린다.
      // 숨기면 '다시 만들기'를 눌러도 아무 일도 안 일어난 것처럼 보였다 (2026-11-18)
      if(this.generating || this.statusOk || !this.statusMessage || (this.rdSched && !this.genFailed)) return null;
      // 완화를 켜고도 실패했으면 완화로 풀 수 있는 칸은 원인이 아니다 — 못 바꾸는 칸(잠근 칸·주휴)만으로 인원을 세고,
      // 엄격 기준 신호등(feas)이 짚은 칸은 쓰지 않는다 (정밀 진단 diagResult 는 완화 기준으로 다시 돈다 — diagnoseConflicts)
      const relax=!!this.allowPreRelax;
      const short=relax ? this._staffingSlack(true).short : (((this.staffingAlerts||{}).short)||[]);
      const anchored=[...(((this.diagResult||{}).anchored)||[]), ...(relax ? [] : (((this.feas||{}).anchored)||[]))].filter(a=>a&&(a.nurse_id||a.date));
      const seen=new Set(); const fixes=[];
      for(const a of anchored){
        const key=`${a.nurse_id}|${a.date}`; if(seen.has(key)) continue; seen.add(key);
        const nurse=this.nurses.find(n=>n.id===a.nurse_id);
        const code=a.nurse_id && a.date ? (this.prevSchedule[a.nurse_id]||{})[a.date] : '';
        const label=nurse && a.date ? `${nurse.name} · ${fmtMD(a.date)}${code ? ' '+this.rdCodeName(code) : ''}` : a.label;
        fixes.push({kind:'cell', label, code, nid:a.nurse_id, iso:a.date});
        if(fixes.length>=3) break;
      }
      let title, body;
      if(short.length){
        const a=short[0]; const k=a.needed-a.avail;
        title=`${fmtKo(a.dk)} 근무 인원이 ${k}명 모자라 이 조건으로는 만들 수 없어요.`;
        body=relax ? `완화를 켜도 그날 잠근 칸·주휴를 빼면 나올 수 있는 사람은 ${a.avail}명인데 필요 인원은 ${a.needed}명입니다. 잠금을 풀거나 필요 인원을 바꿔 주세요.`
          : `그날 나올 수 있는 사람은 ${a.avail}명인데 필요 인원은 ${a.needed}명입니다. 아래 셋 중 하나를 바꾸면 풀립니다.`;
        if(fixes.length<3){
          const req={...(this.requirements?.[['sun','mon','tue','wed','thu','fri','sat'][new Date(a.dk+'T00:00:00').getDay()]]||{}), ...(this.prevDayReqs?.[a.dk]||{})};
          const p=['D','E','N'].sort((x,y)=>(+req[y]||0)-(+req[x]||0))[0];
          const need=+req[p]||0;
          if(need>1) fixes.push({kind:'req', label:`${fmtMD(a.dk)} ${PERIOD_KO[p]} 필요 인원 ${need} → ${need-1}`, dk:a.dk, period:p});
        }
      }else{
        // 생성 결과·신호등의 한 줄 요약이 있으면 그것을 쓴다 — 진단 첫 줄('원인 진단 결과:')은 아무것도 말하지 않는다
        const summary=((this.diagResult||{}).summary)||(!relax&&(this.feas||{}).status==='infeasible' ? (this.feas||{}).summary : '');
        const first=(this.statusMessage||'').split('\n').map(s=>s.replace(/^[★⚠❌✗\s]+/,'').trim()).find(s=>s&&!/^[━─=]+/.test(s)&&!/원인 진단 결과:?$/.test(s))||'';
        title=summary ? `이 조건으로는 만들 수 없어요. ${summary}` : `이 조건으로는 만들 수 없어요.${first ? ' '+first.slice(0,80) : ''}`;
        body='아래에서 하나를 고치거나 사전입력 완화를 켜고 다시 만들어 보세요. 잠근 칸은 완화해도 바뀌지 않습니다.';
        if(relax){
          title='사전입력 완화를 켜도 만들 수 없어요 — 완화로 바꿀 수 없는 칸끼리 규칙이 맞지 않습니다.';
          body=`완화는 잠근 칸(🔒)${this.allowJuhuRelax?'':'과 주휴'}·지난달 칸을 바꾸지 않습니다. ‘왜 안 되는지 자세히 보기’가 그 칸들만 두고 부딪히는 곳을 짚어 줍니다 — 짚인 날의 잠금을 풀고 다시 만들어 보세요.`;
        }
      }
      if(this.rdSched) body+=' 아래 표는 다시 만들기 전에 만든 표 그대로입니다.';
      return {title, body, fixes: fixes.slice(0,3)};
    },
    rdApplyFix(f){
      if(f.kind==='cell') this.jumpToPreCell(f.nid, f.iso);
      else if(f.kind==='req'){
        const d=new Date(f.dk+'T00:00:00');
        const cur=this.getPrevDayReq(d,f.period); const base=this.getDefaultDayReq(d,f.period);
        const v=(cur!==null&&cur!==undefined)?cur:base;
        if(v<=1) return;
        this._pushUndo(); this.setPrevDayReq(d,f.period,v-1);
        this._checkViolations&&this._checkViolations();
        this.rdUndoToast(`${fmtMD(f.dk)} ${PERIOD_KO[f.period]} 필요 인원을 ${v-1}명으로 줄였습니다.`);
      }
    },
    rdRelaxAndRemake(){ this.allowPreRelax=true; this.generate(); },
    // 근무표를 만든(연) 뒤 사전입력 칸이 바뀌었는가 — 표는 고치기 전 사전입력으로 만든 것이라 다시 만들어야 반영된다.
    // 기준(_preAtMake)은 새 표가 설 때의 사전입력(trackEdits), 저장본을 열면 저장할 때의 사전입력. 기준을 모르면 알리지 않는다
    get rdPreChanged(){ return !this.generating && this._preAtMake!=null && this.rdSched && this._preAtMake!==this._preKey(); },
    rdRemake(){ this.activeTab='schedule'; if(!this.generating) this.makeOpen(); },

    // ── 서랍 (요약·리포트) ──
    get rdDrawerTabs(){
      const rx=this.rdRelaxedCount;
      const w=(this.scheduleWarnings||[]).length;
      const wr=this.wishReport; const unmet=wr ? Math.max(0,(wr.total_requested||0)-(wr.total_granted||0)) : 0;
      return [
        {id:'summary', label:'요약', n:0, tip:'간호사별 야간·주말 수와 누적 편차'},
        {id:'relaxed', label:'원티드 미반영', n:rx, err:true, tip:'사전입력과 다르게 배정된 칸'},
        {id:'v', label:'연차(V) 설명', n:(this.vReport&&this.vReport.total)||0, tip:'연차가 왜 어디에 들어갔는지'},
        {id:'teukgeun', label:'오프특근', n:(this.offTeukgeun||[]).length, tip:'오프인데 근무로 잡힌 날'},
        {id:'warn', label:'주의', n:w, tip:'확인이 필요한 배정'},
        {id:'wish', label:'위시 반영', n:unmet, tip:'희망 근무가 얼마나 들어갔는지'},
        {id:'log', label:'생성 기록', n:0, tip:'계산 방식·시간·정확도'},
      ];
    },
    get rdDrawerBadge(){ return this.rdRelaxedCount + (this.offTeukgeun||[]).length + (this.scheduleWarnings||[]).length; },
    rdOpenDrawer(tab){ this.showReports=true; if(tab) this.reportTab=tab; },
    get rdRelaxedList(){
      const out=[];
      for(const [nid,cells] of Object.entries(this.relaxedCells||{})){
        const nurse=this.nurses.find(n=>n.id===nid); const name=nurse?nurse.name:nid;
        for(const [dk,info] of Object.entries(cells||{})){
          out.push({nid, dk, name, date:fmtKo(dk), from:info.original, to:info.assigned, note:(this.cellNotes?.[nid]?.[dk])||'', boost:(this.relaxBoosts||{})[nid]||0, locked:!!this.rdRelocked[nid+'|'+dk]});
        }
      }
      out.sort((a,b)=>(b.note?1:0)-(a.note?1:0));
      return out;
    },
    relockCell(nid, dk){
      const info=this.relaxedCells?.[nid]?.[dk]; if(!info) return;
      this._pushUndo();
      if(!this.prevSchedule[nid]) this.prevSchedule[nid]={};
      this.prevSchedule[nid][dk]=info.original;
      if(!this.lockedCells[nid]) this.lockedCells[nid]={};
      this.lockedCells[nid][dk]=true;
      this.rdRelocked={...this.rdRelocked, [nid+'|'+dk]:true};
      this._checkViolations&&this._checkViolations();
      const nurse=this.nurses.find(n=>n.id===nid);
      this.rdUndoToast(`${nurse?nurse.name:''} ${fmtMD(dk)} 칸을 ${info.original}(으)로 되돌리고 잠갔습니다. 다시 만들기를 누르세요.`);
    },
    get rdSummaryRows(){
      const rows=this.nurseSummaryData||[]; if(!rows.length) return [];
      const pool=rows.filter(r=>!r.exclN); const avg=pool.length ? pool.reduce((a,r)=>a+r.totalNights,0)/pool.length : 0;
      return rows.map(r=>{ const dev=r.exclN ? null : Math.round(r.totalNights-avg); return {...r, dev, devLabel: dev===null ? '※' : (dev>0?'+'+dev:String(dev)), devCls: dev===null?'':(dev>=2?'hi':(dev<=-2?'lo':''))}; });
    },

    // ── 저장 버튼 상태 ──
    get rdSaveLabel(){ return this.rdSched && this.rdSaved ? '저장됨' : '저장'; },
    get rdSaveTip(){ return this.rdSched ? (this.rdSaved ? '자동으로 저장됐습니다. 이름을 바꿔 따로 저장하려면 누르세요.' : '이 근무표를 이름 붙여 저장합니다.') : '만든 뒤에 저장할 수 있어요.'; },
    // ── 하나만 만들 때의 선택 (결정 1-77 → 1-93) — 달마다 기억한다 (localStorage 'ns_genpref:<병동>:<년-월>').
    //    방향은 여러 개 만들기와 같은 키워드다. 옛 저장 값(세 축 night·rest·weekend = a|mid|b)은 키워드로 바꿔 읽는다 ──
    rdPrefTimes(){ return PREF_TIMES; },
    _genPrefKey(){ return `ns_genpref:${this.currentProfile||''}:${this.year}-${String(this.month).padStart(2,'0')}`; },
    _genPrefClean(o){ const p={...PREF_DEFAULT, keys:[]}; o=o||{};
      const want=Array.isArray(o.keys) ? o.keys : PREF_AXES.filter(a=>['a','b'].includes(o[a.id])).map(a=>a.id+'.'+o[a.id]);
      for(const k of MAKE_KEYWORDS) if(want.includes(k.id) && !this._kwClash(p.keys, k.id)) p.keys.push(k.id);
      if(PREF_TIMES.some(t=>t.v===o.time)) p.time=o.time;
      if(typeof o.quick==="boolean") p.quick=o.quick;
      return p; },
    // 이 달에 고른 것 — 없으면 null. 저장소를 못 쓰는 곳(시크릿 창 등)에서는 기본값을 돌려준다
    genPrefGet(){ this.genPrefTick;
      try{ const s=localStorage.getItem(this._genPrefKey()); return s ? this._genPrefClean(JSON.parse(s)) : null; }catch(e){ return this._genPrefClean(null); } },
    _genPrefLast(){ try{ const s=localStorage.getItem('ns_genpref_last:'+(this.currentProfile||'')); return s ? this._genPrefClean(JSON.parse(s)) : null; }catch(e){ return null; } },
    _genPrefStore(o){ const p=this._genPrefClean(o);
      try{ localStorage.setItem(this._genPrefKey(), JSON.stringify(p)); localStorage.setItem('ns_genpref_last:'+(this.currentProfile||''), JSON.stringify(p)); }catch(e){}
      if(typeof p.time==='number') this.generateTimeout=p.time;
      this.genPrefTick++; return p; },
    _prefText(p){ return [p.keys.length ? this.multiLabel(p.keys) : '고르게 균형', p.time==='endless' ? '멈출 때까지' : `${p.time}분`, ...(p.quick!==false?['초안 먼저']:[])].join(' · '); },
    // 만들기 단추 옆 한 줄
    get rdPrefSummary(){ const p=this.genPrefGet(); return p ? this._prefText(p) : ''; },
    // 요청에 싣는 것 — 고른 방향의 배점을 곱한 규칙 목록(고른 것이 없으면 싣지 않는다 → 서버가 설정 값을 쓴다)과, 계속 찾기면 오차 0
    genPrefPatch(){
      const p=this.genPrefGet()||this._genPrefClean(null), out={};
      const rules=this._rulesWithFx(p.keys.map(k=>MAKE_KEYWORDS.find(x=>x.id===k).fx));
      if(rules) out.scoring_rules=rules;
      if(p.time==='endless') out.mip_gap=0;
      return out;
    },

    // ── 만들기 마법사 (결정 1-93) — 만들기를 누르면 늘 이 창에서 시작한다: ① 몇 개(하나만·여러 개) ② 방향 ③ 찾는 시간 → 만들기.
    //    여러 개는 이어서 ④ 만드는 중 ⑤ 견주기. 첫 화면의 '지난번처럼 만들기'는 지난번 고른 그대로 바로 시작한다.
    //    크기는 고정, 창 밖을 눌러도 닫히지 않는다 ──
    _makeLastKey(){ return 'ns_make_last:'+(this.currentProfile||''); },
    // 지난번에 만든 방식 — 기록이 없어도 하나만의 선택을 저장해 둔 적이 있으면(마법사가 생기기 전) 하나만으로 본다
    _makeLast(){ let o=null; try{ o=JSON.parse(localStorage.getItem(this._makeLastKey())||'null'); }catch(e){}
      return o&&['one','multi'].includes(o.count) ? o : ((this.genPrefGet()||this._genPrefLast()) ? {count:'one'} : null); },
    _makeRemember(){ const M=this.multi, o=this.mk.count==='multi' ? {count:'multi', tables:M.tables.map(t=>[...t.keys]), gap:M.gap, cap:M.cap} : {count:'one'};
      try{ localStorage.setItem(this._makeLastKey(), JSON.stringify(o)); }catch(e){} this.genPrefTick++; },
    makeSteps(){ return this.mk.count==='multi' ? ['count','dir','time','run','cmp'] : ['count','dir','time']; },
    makeOpen(){
      const M=this.multi; if(M.running){ this.mk={...this.mk, open:true, count:'multi', step:'run'}; return; }
      const p=this.genPrefGet()||this._genPrefLast()||this._genPrefClean(null), last=this._makeLast();
      if(last&&last.count==='multi'&&Array.isArray(last.tables)&&last.tables.length){ M.tables=last.tables.slice(0, 4).map(k=>({keys:this._genPrefClean({keys:k}).keys})); if([0.01,0.02,0.05].includes(last.gap)) M.gap=last.gap; if([10,20,60].includes(last.cap)) M.cap=last.cap; }
      this.mk={open:true, step:'count', count:last ? last.count : 'one', keys:[...p.keys], time:p.time, quick:p.quick!==false};
    },
    // 여러 개 만든 표를 다시 본다 (만드는 중이면 진행, 끝났으면 견주기)
    makeViewMulti(){ this.mk={...this.mk, open:true, count:'multi', step:this.multi.running ? 'run' : 'cmp'}; },
    makePick(count){ this.mk.count=count; this.mk.step='dir'; },
    makeBack(){ const s=this.makeSteps(), i=s.indexOf(this.mk.step); this.mk.step=this.mk.step==='cmp' ? 'dir' : s[Math.max(0, i-1)]; },
    makeNext(){ const s=this.makeSteps(), i=s.indexOf(this.mk.step); if(i<2) this.mk.step=s[i+1]; },
    // 지난번에 고른 것 한 줄 — 없으면 '' (첫 화면의 '지난번처럼 만들기')
    get makeLastText(){ this.genPrefTick; const last=this._makeLast(); if(!last) return '';
      if(last.count==='multi'){ const n=(last.tables||[]).length; return n ? `여러 개 · ${n}장 (${(last.tables||[]).map(k=>this.multiLabel(k).replace(' (지금 설정 그대로)', '')).join(' / ')})` : ''; }
      const p=this.genPrefGet()||this._genPrefLast(); return p ? '하나만 · '+this._prefText(p) : ''; },
    makeStart(){
      if(this.generating) return;
      this._makeRemember();
      if(this.mk.count==='multi'){ this.multiRun(); return; }
      this._genPrefStore({keys:this.mk.keys, time:this.mk.time, quick:this.mk.quick});
      this.mk.open=false; this.generate();
    },
    // 지난번처럼 — 창의 값은 makeOpen 이 지난번 것으로 채워 두었다
    makeAgain(){ if(this.makeLastText) this.makeStart(); },
    makeKey(e){ if(!this.mk.open||e.key!=='Escape') return; this.mk.open=false; },
    // 한 표 안에서 같은 배점을 건드리는 방향끼리는 함께 고르지 못한다 — 부딪히는 방향의 이름, 없으면 null
    _kwClash(keys, id){ const kw=MAKE_KEYWORDS.find(k=>k.id===id); if(!kw||(keys||[]).includes(id)) return null;
      const hit=(keys||[]).map(k=>MAKE_KEYWORDS.find(x=>x.id===k)).find(o=>o && Object.keys(o.fx).some(f=>f in kw.fx)); return hit ? hit.label : null; },
    makeClash(id){ return this._kwClash(this.mk.keys, id); },
    makeToggle(id){ const k=this.mk.keys; this.mk.keys=k.includes(id) ? k.filter(x=>x!==id) : (this._kwClash(k, id) ? k : [...k, id]); },
    get makeDirHint(){ const ks=MAKE_KEYWORDS.filter(k=>this.mk.keys.includes(k.id)); return ks.length ? ks.map(k=>`${k.label} — ${k.hint}`).join('\n') : '아무것도 고르지 않으면 지금 설정 그대로(균형)로 만듭니다.'; },

    // 배점 규칙에 곱하기 묶음(fx: {규칙 이름표: 배수})들을 건 사본 — 아무것도 걸리지 않으면 null (서버가 설정 값을 쓴다)
    _rulesWithFx(fxs){
      const mul=new Map();
      for(const fx of fxs) for(const [k,f] of Object.entries(fx||{})) for(const r of (this.scoringRules||[])) if(PREF_RULE[k]&&PREF_RULE[k](r)) mul.set(r, (mul.get(r)||1)*f);
      return mul.size ? (this.scoringRules||[]).map(r=>mul.has(r) ? {...r, score:Math.round(r.score*mul.get(r))} : {...r}) : null;
    },

    // ── 여러 개 만들기 (결정 1-86) — 방향(키워드 묶음)이 다른 표를 차례로 만들어 나란히 견준다. 공통 설정: 추가 생성 안 함 ·
    //    목표 차이(1·2·5%) · 표 한 장의 시간 상한. 서버는 한 번에 한 장만 만들어 차례로 돈다. 만든 표는 모두 이름 붙여 저장하고,
    //    고른 표를 화면에 연다. 한 표 안의 키워드는 같은 배점을 건드리지 않는 것끼리만 (겹치면 고르지 못한다) ──
    multi: {gap:0.02, cap:20, tables:[{keys:[]}, {keys:[]}], running:false, idx:-1, stopped:false, started:0, tick:0, results:[], picked:null},
    rdMakeKeywords(){ return MAKE_KEYWORDS; },
    multiClash(ti, id){ return this._kwClash(this.multi.tables[ti]?.keys||[], id); },
    multiToggle(ti, id){ const t=this.multi.tables[ti]; if(!t) return; if(t.keys.includes(id)) t.keys=t.keys.filter(k=>k!==id); else if(!this.multiClash(ti, id)) t.keys=[...t.keys, id]; },
    multiAdd(){ if(this.multi.tables.length<4) this.multi.tables.push({keys:[]}); },
    multiRemove(ti){ if(this.multi.tables.length>1) this.multi.tables.splice(ti, 1); },
    multiLabel(keys){ const ls=MAKE_KEYWORDS.filter(k=>(keys||[]).includes(k.id)).map(k=>k.label); return ls.length ? ls.join(' + ') : '균형 (지금 설정 그대로)'; },
    // 실제로 만들 표 — 같은 묶음은 한 번만
    get multiPlan(){ const seen=new Set(), out=[]; for(const t of this.multi.tables){ const keys=MAKE_KEYWORDS.filter(k=>t.keys.includes(k.id)).map(k=>k.id), sig=keys.join('|'); if(seen.has(sig)) continue; seen.add(sig); out.push({keys, label:this.multiLabel(keys)}); } return out; },
    get multiElapsed(){ this.multi.tick; return this.multi.running&&this.multi.started ? Math.floor((Date.now()-this.multi.started)/1000) : 0; },
    async multiRun(){
      const M=this.multi; if(M.running||this.generating) return;
      const plan=this.multiPlan, base=this._basePayload(), pid=this.currentProfile, ym={year:+this.year, month:+this.month};
      if(!plan.length||!this.nurses.length) return;
      M.results=plan.map(p=>({...p, state:'wait'})); M.running=true; M.stopped=false; M.picked=null; this.mk.count='multi'; this.mk.step='run'; this.genFirst=null;
      this.generating=true; this.continuing=false; this.stopRequested=false; this.genEndless=false;
      const timer=setInterval(()=>{ M.tick++; }, 1000);
      try{
        for(let i=0;i<plan.length&&!M.stopped;i++){
          const R=M.results[i], rules=this._rulesWithFx(plan[i].keys.map(k=>MAKE_KEYWORDS.find(x=>x.id===k).fx));
          const payload={...base, mip_gap:M.gap, time_limit:M.cap*60, ...(rules ? {scoring_rules:rules} : {})};
          M.idx=i; M.started=Date.now(); R.state='run';
          this.solverLogs=[]; this._logSeq=0; this._solveReset(); this.solveProgress={gap_percent:null, nodes:0, has_solution:false, is_running:false};
          this.sseSource=new EventSource('/api/generate/stream');
          this.sseSource.onmessage=e=>{ const d=JSON.parse(e.data); if(d.type==='log') this._pushLog(d.msg); else if(d.type==='hint') this._pushLog(d.msg, true); else if(d.type==='progress') this.solveProgress=d; else if(d.type==='done'&&this.sseSource){ this.sseSource.close(); this.sseSource=null; } };
          let r=null;
          try{ r=await this.api('POST', '/api/generate', payload); }catch(e){ r={success:false, message:'서버 오류: '+e.message}; }
          if(this.sseSource){ this.sseSource.close(); this.sseSource=null; }
          R.sec=Math.floor((Date.now()-M.started)/1000);
          if(!this._resultHere({profile_id:pid, ...ym})){ M.stopped=true; R.state='fail'; R.msg='만드는 동안 병동이나 달이 바뀌어 멈췄습니다'; break; }
          R.result=r; R.payload=payload; R.log=this.solverLogs.map(l=>l.msg).join('\n');
          if(r&&r.success){ R.state='done'; R.stats=this.multiStats(r); R.saveName=`${ym.month}월 · ${plan[i].label}`; await this._multiSave(R, ym); }
          else { R.state='fail'; R.msg=String((r&&r.message)||'만들지 못했습니다').split('\n')[0]; }
          if(r&&r.stopped) M.stopped=true;
        }
      } finally {
        clearInterval(timer); for(const R of M.results) if(R.state==='wait'||R.state==='run') R.state='skip';
        M.running=false; M.idx=-1; this.generating=false; this.stopRequested=false; if(this.mk.step==='run') this.mk.step='cmp'; this.loadSavedList&&this.loadSavedList();
      }
    },
    multiStop(){ this.multi.stopped=true; this.stopGenerate(); },
    // 만든 표를 이름 붙여 저장 — 같은 이름·같은 달의 옛 것은 새것으로 바꾼다 (자동저장본은 건드리지 않는다)
    async _multiSave(R, ym){
      const r=R.result, body={...ym, name:R.saveName, nurses:this.nurses, requirements:this.requirements, rules:this.rules, schedule:r.schedule, solver_log:R.log||'',
        prev_schedule:this.prevSchedule, nurse_scores:r.nurse_scores||{}, nurse_score_details:r.nurse_score_details||{}, locked_cells:this.lockedCells, cell_notes:this.cellNotes,
        holidays:this.holidays, prev_day_reqs:this.prevDayReqs, prev_month_nights:this.prevMonthNights, relaxed_cells:r.relaxed_cells||{}};
      try{ let old=[]; try{ old=((await this.api('GET', '/api/schedules'))||[]).filter(s=>s.name===R.saveName&&+s.year===ym.year&&+s.month===ym.month).map(s=>s.id); }catch(e){}
        await this.api('POST', '/api/schedules', body); for(const id of old){ try{ await this.api('DELETE', `/api/schedules/${id}`); }catch(e){} } R.saved=true;
      }catch(e){ R.saved=false; }
    },
    // 한 장의 숫자 — 그 달에 만든 칸으로(지난달 표의 주는 빼고), 나이트킵은 빼고 센다. 견주는 표의 열과 같은 차례
    multiStats(r){
      const days=this.scheduleDays, n0=days.findIndex(d=>!this.isCarryDay(d)), sched=r.schedule||{}, ext=r.extended_schedule||{};
      const per=c=>{ const s=this.shiftMap.get(c); return s ? s.period : ''; }, rest=c=>['rest','leave'].includes(per(c)), night=c=>per(c)==='night';
      let one=0, heavy=0, nine=0, singleN=0, v=0; const nights=[], wk=[];
      for(const nu of this.nurses){
        if(this._keeperInMonth(nu, this.year, this.month)) continue;
        const code=days.map(d=>{ const dk=this.dayKey(d); return this.isNurseInactive(nu, d) ? '' : (sched[nu.id]?.[dk] || ext[nu.id]?.[dk] || this.prevSchedule?.[nu.id]?.[dk] || ''); });
        const row=code.map(c=>!c ? '-' : (rest(c) ? 'R' : 'W')); if(!row.includes('W')) continue;
        for(let k=Math.max(n0, 1);k<row.length-1;k++){
          if(row[k]==='R'&&row[k-1]==='W'&&row[k+1]==='W'){ one++; let L=0, Rr=0; for(let j=k-1;j>=0&&row[j]==='W';j--) L++; for(let j=k+1;j<row.length&&row[j]==='W';j++) Rr++; if(L+Rr>=8) heavy++; }
          if(night(code[k])&&!night(code[k-1])&&!night(code[k+1])) singleN++;
        }
        let worst=0; for(let s=n0;s+10<=row.length;s++) worst=Math.max(worst, row.slice(s, s+10).filter(x=>x==='W').length); if(worst>=9) nine++;
        const inMonth=days.map(d=>!this.isOverflow(d));
        v+=code.filter((c, i)=>inMonth[i]&&c==='V').length;
        if((nu.capable_shifts||[]).some(c=>night(c))) nights.push(code.filter((c, i)=>inMonth[i]&&night(c)).length);
        wk.push(days.filter((d, i)=>inMonth[i]&&row[i]==='W'&&(d.getDay()===0||d.getDay()===6||this.isHoliday(d))).length);
      }
      const range=a=>a.length ? Math.max(...a)-Math.min(...a) : 0;
      return {one, heavy, nine, singleN, nightRange:range(nights), weekendRange:range(wk), v, relaxed:Object.values(r.relaxed_cells||{}).reduce((a, c)=>a+Object.keys(c||{}).length, 0),
        gap:r.mip_gap_percent!=null ? Math.round(r.mip_gap_percent*100)/100 : null};
    },
    // ── 표 기록 (결정 1-95) — 이번 만들기에서 화면에 나온 표를 1번(초안)·2번…으로 남긴다. 번호를 누르면 그 표를 보고,
    //    지난 번호를 보는 중이면 새 표가 나와도 화면을 바꾸지 않는다(solver.js). 두 번호를 골라 한 달력에 겹쳐 견준다.
    //    브라우저에 따로 보관해 새로고침 뒤 그 달 자동저장본을 열면 되살아난다. 저장한 근무표 목록에는 섞지 않는다 ──
    get verLast(){ return this.verLog.length ? this.verLog[this.verLog.length-1].n : null; },
    get verPinned(){ return this.verLog.length>1 && this.verCur!=null && this.verCur!==this.verLast; },
    get verFresh(){ return this.verLog.filter(v=>v.n>this.verSeen).map(v=>v.n); },
    _verKey(){ return `ns_verlog:${this.currentProfile||''}:${this.year}-${String(this.month).padStart(2,'0')}`; },
    _verTime(sec){ sec=Math.round(sec||0); return sec>=60 ? `${Math.floor(sec/60)}분 ${String(sec%60).padStart(2,'0')}초` : `${sec}초`; },
    verChipSub(v){ return [this._verTime(v.sec), v.gap==null ? null : (v.gap>=100 ? '최고와 차이 큼' : `최고와 ${Math.round(v.gap*10)/10}% 차이`)].filter(Boolean).join(' · '); },   // 처음 나온 답은 차이가 몇백 %일 수 있다 — 숫자 대신 '큼'
    verChipName(v){ return `${v.n}번`+(v.n===1 ? ' · 초안' : '')+(v.n===this.verLast&&this.verLog.length>1 ? ' · 최신' : ''); },
    verReset(){ this.verLog=[]; this.verCur=null; this.verSeen=0; this.verCmpOff(); this.verNums.open=false; },   // 화면에서만 지운다 (병동을 바꿀 때)
    verClear(){ try{ localStorage.removeItem(this._verKey()); }catch(e){} this.verReset(); },
    _verPush(r, payload, shown){
      // 같은 표면 번호를 늘리지 않는다 — 찾는 도중에 이미 나온 표가 끝난 표로 다시 올 때, 내용만 끝난 것으로 바꾼다
      const same=this.verLog[this.verLog.length-1];
      if(same && JSON.stringify(same.result.schedule)===JSON.stringify(r.schedule)){
        same.result=r; same.payload=payload||same.payload; same.gap=r.mip_gap_percent??same.gap; same.stats=this.multiStats(r);
        if(shown){ this.verCur=same.n; this.verSeen=Math.max(this.verSeen, same.n); }
        this._verStore(); return same; }
      const n=(this.verLast||0)+1, v={n, sec:(this.genElapsedBase||0)+(this.generateElapsed||0), gap:r.mip_gap_percent??null, result:r, payload, stats:this.multiStats(r), screen:null};
      const L=this.verLog.length>=8 ? [this.verLog[0], ...this.verLog.slice(2)] : this.verLog;   // 여덟 장까지 — 넘치면 초안은 두고 그다음 것부터 버린다
      this.verLog=[...L, v];
      if(shown){ this.verCur=n; this.verSeen=n; }
      this._verStore(); return v;
    },
    // 찾는 도중의 표 (결정 1-97) — 엔진이 더 나은 답을 낼 때마다 서버가 보낸다. 번호를 붙여 남기고, 최신 번호를 보는 중이고 손으로 고치지 않았으면
    // 화면도 따라간다. 사전입력 지키기 단계(keep)의 표는 점수가 낮으니 첫 찾기에서 점수 단계의 표가 나오기 전까지만 받는다
    _verPartial(t, payload, cont){
      if(!t||!t.schedule||!this.generating||this.multi.running) return;
      if(+payload.year!==+this.year||+payload.month!==+this.month) return;
      if(t.stage==='keep' && (cont || this.verLog.some(v=>!(v.result&&v.result.stage==='keep')))) return;
      const last=this.verLog[this.verLog.length-1];
      if(last && JSON.stringify(last.result.schedule)===JSON.stringify(t.schedule)) return;
      const edited=(this._originalSchedule ? this.getManualEditCount() : 0)>0;
      if(!this.verPinned && !edited){ this._showResult(t); this._verPush(t, payload, true); this.rdSaved=false; this.activeTab='schedule'; return; }
      const v=this._verPush(t, payload, false);
      this.rdToast={msg:`${v.n}번 표가 나왔습니다 — ${edited?'고친 표':'보던 표'}는 그대로 두었습니다`, act:'보기', fn:()=>this.verShow(v.n)}; clearTimeout(this._rdToastTimer);
    },
    // 화면의 표를 떠날 때 손으로 고친 것이 있으면 그 번호에 붙여 둔다 — 다시 열면 고친 채로 나온다
    _verKeepScreen(){ const v=this.verLog.find(x=>x.n===this.verCur); if(v) v.screen=(this._originalSchedule&&this.getManualEditCount()>0) ? JSON.parse(JSON.stringify(this.schedule)) : null; },
    _showResult(r, log){
      this.statusOk=true; this.statusMessage=r.message||''; this.genFailed=false; this.diagResult=null; this.fixResult=null;
      this.generationReport=r.generation_report||null; this.wishReport=r.wish_report||null; this.offTeukgeun=r.off_teukgeun||[]; this.managerCheck=r.manager_check||[]; this.vReport=r.v_report||null;
      this.relaxBoosts=r.relax_boosts||{}; this.fairnessOffsets=r.fairness_offsets||null; this.weekendOffsets=r.weekend_offsets||null;
      this.schedule=JSON.parse(JSON.stringify(r.schedule||{})); this.extendedSchedule=r.extended_schedule||{}; this.nurseScores=r.nurse_scores||{}; this.nurseScoreDetails=r.nurse_score_details||{};
      this.mipGapPercent=r.mip_gap_percent!=null ? r.mip_gap_percent : null; this.scheduleStopped=r.stopped===true; this.relaxedCells=r.relaxed_cells||{};
      this.readjustPins={}; this.readjustChanged={}; this.readjustSummary=''; this.trackEdits();
    },
    verShow(n){
      const v=this.verLog.find(x=>x.n===n); if(!v||!v.result) return;
      if(n!==this.verCur){ this._verKeepScreen(); this._showResult(v.result);
        if(v.screen) this.schedule=JSON.parse(JSON.stringify(v.screen));
        this.verCur=n; this.activeTab='schedule'; this.loadedSavedId=null; this.rdSaved=(n===this.verLast&&!v.screen);
        if(!this.generating&&v.payload) this._setContBase(v.payload, v.result);
        this.checkScheduleViolations&&this.checkScheduleViolations(); }
      this.verSeen=Math.max(this.verSeen, n); this.rdToast=null;
      if(this.verCmp.on&&!this.verCmp.saved){ if(!(this.verCmp.a<n&&this.verLog.some(x=>x.n===this.verCmp.a))) this.verCmp.a=this._verPrevOf(n);   // 견주는 앞 표는 화면의 번호보다 앞이어야 한다
        if(this.verCmp.a==null) this.verCmp.on=false; }
      this._verStore();
    },
    _verPrevOf(n){ const p=this.verLog.filter(x=>x.n<n).map(x=>x.n); return p.length ? p[p.length-1] : null; },
    // 따로 저장 — 저장한 근무표 목록에 이름 붙여 남긴다 ('12월 · 2번 표')
    async verSave(n){ const v=this.verLog.find(x=>x.n===n); if(!v) return; if(n===this.verCur) this._verKeepScreen();
      const R={result:{...v.result, schedule:v.screen||v.result.schedule}, saveName:`${this.month}월 · ${n}번 표${n===1?'(초안)':''}`, log:''};
      await this._multiSave(R, {year:+this.year, month:+this.month}); this.loadSavedList&&this.loadSavedList();
      this.toast(R.saved ? `‘${R.saveName}’로 저장했습니다 — 불러오기에서 열 수 있어요` : '저장하지 못했습니다', R.saved?'success':'error', 5000); },
    _verStore(){
      const pack=lite=>JSON.stringify({cur:this.verCur, seen:this.verSeen, list:this.verLog.map(v=>({n:v.n, sec:v.sec, gap:v.gap, stats:v.stats, screen:v.screen, result:lite ? {schedule:v.result.schedule, extended_schedule:v.result.extended_schedule, relaxed_cells:v.result.relaxed_cells, mip_gap_percent:v.result.mip_gap_percent, message:v.result.message, stopped:v.result.stopped} : {...v.result, solver_log:undefined}}))});
      try{ localStorage.setItem(this._verKey(), pack(false)); }catch(e){ try{ localStorage.setItem(this._verKey(), pack(true)); }catch(e2){ try{ localStorage.removeItem(this._verKey()); }catch(e3){} } }
    },
    // 저장본을 연 뒤 — 그 표가 보관해 둔 기록의 한 번호와 같으면 기록을 되살리고(새로고침 뒤 자동저장본 열기), 아니면 기록을 지운다
    verAfterLoad(){
      let o=null; try{ o=JSON.parse(localStorage.getItem(this._verKey())||'null'); }catch(e){}
      const now=JSON.stringify(this.schedule||{}), list=(o&&Array.isArray(o.list)) ? o.list.filter(v=>v&&v.result&&v.result.schedule) : [];
      const hit=[...list].reverse().find(v=>JSON.stringify(v.screen||v.result.schedule)===now);
      if(!hit){ this.verClear(); return; }
      this.verLog=list.map(v=>({...v, payload:null})); this.verCur=hit.n; this.verSeen=Math.max(o.seen||0, hit.n); this.verCmpOff();
    },

    // 견주기 — 화면의 표(뒤)와 앞 번호 a 를 한 달력에. 칸마다 그대로·쉬게 됨·근무하게 됨·다른 근무로
    get verCmpA(){ const c=this.verCmp; if(!c.on) return null;
      return c.saved ? {n:null, name:c.saved.name, result:{schedule:c.saved.schedule, extended_schedule:{}}, stats:c.saved.stats} : (this.verLog.find(v=>v.n===c.a)||null); },
    verCmpOff(){ this.verCmp.on=false; this.verCmp.a=null; this.verCmp.saved=null; },
    // 이 달에 저장한 근무표 — 번호 대신 이 가운데 하나와도 견줄 수 있다 (화면의 표가 뒤, 저장한 표가 앞)
    get rdSavedOfMonth(){ return (this.savedSchedules||[]).filter(s=>+s.year===+this.year&&+s.month===+this.month); },
    async verCmpSaved(id){
      try{ const d=await this.api('GET', `/api/schedules/${id}`), x=d.data||{}, sched=x.schedule||{};
        if(+(x.year||d.year)!==+this.year||+(x.month||d.month)!==+this.month){ this.toast('이 달의 근무표만 견줄 수 있습니다', 'warn'); return; }
        this.verCmp.saved={id, name:d.name||x.name||'저장한 근무표', schedule:sched, stats:this.multiStats({schedule:sched, extended_schedule:{}, relaxed_cells:x.relaxed_cells||{}})};
        this.verCmp.a=null; this.verCmp.on=true; this.activeTab='schedule';
      }catch(e){ this.toast('저장한 근무표를 읽지 못했습니다 — '+(e.message||''), 'error'); } },
    // 견주는 앞 표 고르기 — 'v2' = 표 기록의 2번, 's31' = 저장한 근무표 31
    verCmpPickA(val){ val=String(val||''); if(val[0]==='s') return this.verCmpSaved(+val.slice(1)); this.verCmp.saved=null; this.verCmp.a=null; this.verCmpPick(+val.slice(1)); if(this.verCmp.a==null) this.verCmpOff(); },
    get verCmpAVal(){ const c=this.verCmp; return c.saved ? 's'+c.saved.id : (c.a!=null ? 'v'+c.a : ''); },
    get verCmpName(){ const A=this.verCmpA; return !A ? '' : (A.n==null ? `‘${A.name}’` : `${A.n}번`); },
    verCmpToggle(){ const c=this.verCmp; if(c.on){ this.verCmpOff(); return; } c.saved=null;
      if(this._verPrevOf(this.verCur)==null){ const nx=this.verLog.find(x=>x.n>this.verCur); if(!nx) return; this.verShow(nx.n); }   // 초안을 보는 중이면 그다음 번호로 가서 초안과 견준다
      c.a=this._verPrevOf(this.verCur); c.on=c.a!=null; },
    verCmpPick(a, b){ if(b!=null&&b!==this.verCur) this.verShow(b); if(a!=null&&a<this.verCur){ this.verCmp.a=a; this.verCmp.on=true; } },
    _cmpPlain(c){ return (c&&this.hideCharge) ? this.plainShift(c) : (c||''); },
    _cmpOld(nid, dk){ const A=this.verCmpA; if(!A) return ''; return this._cmpPlain((A.screen||A.result.schedule)?.[nid]?.[dk]||A.result.extended_schedule?.[nid]?.[dk]||''); },
    _cmpNow(nid, dk){ return this._cmpPlain(this.schedule?.[nid]?.[dk]||this.extendedSchedule?.[nid]?.[dk]||''); },
    _cmpRest(c){ const s=this.shiftMap.get(c&&c[0]==='/' ? c.slice(1) : c); return !c||!s||s.period==='rest'||s.period==='leave'; },
    // '' = 견주지 않음(또는 지난달 표의 칸) · same · rest(쉬게 됨) · work(근무하게 됨) · swap(다른 근무로)
    rdCmpKind(nurse, day){ if(!this.verCmpA||this.isCarryDay(day)||this.isNurseInactive(nurse, day)) return '';
      const dk=this.dayKey(day), a=this._cmpOld(nurse.id, dk), b=this._cmpNow(nurse.id, dk); if(a===b) return 'same';
      const ra=this._cmpRest(a), rb=this._cmpRest(b); return (!ra&&rb) ? 'rest' : ((ra&&!rb) ? 'work' : 'swap'); },
    _cmpShown(k){ return k&&k!=='same'&&this.verCmp.kinds[k]!==false; },
    rdCellCmp(nurse, day){ const c=this.verCmp; if(!c.on) return ''; const k=this.rdCmpKind(nurse, day);
      const two=c.mode==='rows' ? ' vd2' : '';
      if(!this._cmpShown(k)) return (c.dim&&k ? 'vd-same' : '')+two;
      return 'vd '+(c.color ? 'vd-'+k : 'vd-one')+two; },
    // 칸에 곁들이는 앞 표의 근무 — 겹쳐 보기는 바뀐 칸만, 두 줄 보기는 모든 칸
    rdCmpOld(nurse, day){ const c=this.verCmp; if(!c.on||this.isNurseInactive(nurse, day)) return ''; const k=this.rdCmpKind(nurse, day); if(!k) return '';
      if(c.mode==='rows') return this._cmpOld(nurse.id, this.dayKey(day))||'·';
      return (c.old&&this._cmpShown(k)) ? (this._cmpOld(nurse.id, this.dayKey(day))||'빈칸') : ''; },
    rdCmpRowCount(nurse){ if(!this.verCmp.on) return 0; let n=0; for(const d of this.scheduleDays) if(this._cmpShown(this.rdCmpKind(nurse, d))) n++; return n; },
    rdCmpDayCount(day){ if(!this.verCmp.on) return 0; let n=0; for(const nu of this.nurses) if(this._cmpShown(this.rdCmpKind(nu, day))) n++; return n; },
    get rdCmpTotal(){ const out={cells:0, who:0, rest:0, work:0, swap:0}; if(!this.verCmpA) return out;
      for(const nu of this.nurses){ let n=0; for(const d of this.scheduleDays){ const k=this.rdCmpKind(nu, d); if(k&&k!=='same'){ out[k]++; if(this._cmpShown(k)) n++; } } out.cells+=n; if(n) out.who++; } return out; },
    // 숫자 견주기 — 화면의 번호와 견주는 앞 번호 (여러 개 만들기의 견주기와 같은 숫자)
    get rdCmpFacts(){ const A=this.verCmpA; if(!A||!A.stats) return [];
      const B=(this.verLog.find(v=>v.n===this.verCur)||{}).stats||this.multiStats({schedule:this.schedule, extended_schedule:this.extendedSchedule, relaxed_cells:this.relaxedCells});
      return this.rdMultiCols().filter(c=>c[0]!=='gap').map(c=>({label:c[1], tip:c[2], a:A.stats[c[0]], b:B[c[0]]})).filter(f=>f.a!=null&&f.b!=null&&f.a!==f.b)
        .map(f=>({...f, text:`${f.a} → ${f.b}`, tone:f.b<f.a ? 'good' : 'bad', word:f.b<f.a ? '나아짐' : '나빠짐'})); },
    // 번호마다 숫자 창 — 줄 = 견주는 것, 열 = 번호. 줄마다 가장 좋은(작은) 값을 진하게
    verNumRows(){ const L=this.verLog; return [...this.rdMultiCols().map(c=>{ const vals=L.map(v=>v.stats ? v.stats[c[0]] : null), nums=vals.filter(x=>x!=null), min=nums.length ? Math.min(...nums) : null;
        return {label:c[1], tip:c[2], cells:vals.map(x=>({text:x==null ? '—' : x+(c[0]==='gap'?'%':''), best:x!=null&&x===min&&nums.some(y=>y!==min)}))}; }),
      {label:'앞 번호와 달라진 칸', tip:'바로 앞 번호의 표와 근무가 다른 칸 수', cells:L.map((v, i)=>({text:i===0 ? '—' : this._verDiffCount(L[i-1], v)+'칸', best:false}))}]; },
    _verDiffCount(A, B){ let n=0; const a=A.screen||A.result.schedule||{}, b=B.screen||B.result.schedule||{};
      for(const nu of this.nurses) for(const d of this.scheduleDays){ if(this.isCarryDay(d)) continue; const dk=this.dayKey(d); if((a[nu.id]?.[dk]||'')!==(b[nu.id]?.[dk]||'')) n++; } return n; },
    // 표가 떠 있는 채로 더 찾는 동안에는 계산 현황을 한 줄로 줄인다 — 아래 근무표가 보여야 한다
    get rdSolveCompact(){ return !!(this.generating && this.rdSched); },   // 첫 찾기에서도 찾는 도중의 표가 뜨면 줄인다

    // ── 처음 나온 표와 견주기 (결정 1-94) — 초안(이번 만들기의 첫 표)과 지금 표. 손으로 고친 칸은 빼고 엔진이 낸 표끼리 본다.
    //    숫자는 여러 개 만들기의 견주기와 같은 것(multiStats). 달라진 칸이 없으면 null ──
    _draftNow(){ return this._originalSchedule||this.schedule||{}; },
    isDraftDiff(nid, day){ const F=this.genFirst; if(!F||this.isCarryDay(day)) return false; const dk=this.dayKey(day); return (F.schedule?.[nid]?.[dk]||'')!==(this._draftNow()?.[nid]?.[dk]||''); },
    get rdDraftCmp(){
      const F=this.genFirst; if(!F||!this.rdSched) return null;
      let cells=0; const who=new Set();
      for(const n of this.nurses) for(const d of this.scheduleDays) if(this.isDraftDiff(n.id, d)){ cells++; who.add(n.id); }
      if(!cells) return null;
      const A=this.multiStats(F), B=this.multiStats({schedule:this._draftNow(), extended_schedule:this.extendedSchedule, relaxed_cells:this.relaxedCells, mip_gap_percent:this.mipGapPercent});
      const rows=this.rdMultiCols().map(c=>({key:c[0], label:c[1], tip:c[2], a:A[c[0]], b:B[c[0]]}));
      return {cells, who:who.size, sec:F.sec||0, rows, better:rows.filter(r=>r.a!=null&&r.b!=null&&r.b<r.a).length, worse:rows.filter(r=>r.a!=null&&r.b!=null&&r.b>r.a).length};
    },
    rdMultiCols(){ return [['one','1오프','하루짜리 휴무(앞뒤가 근무)의 수'], ['heavy','긴 근무 사이 1오프','앞뒤 근무를 합쳐 8일 이상인 1오프'], ['nine','열흘에 9일 근무','어느 열흘에 9일 넘게 일한 사람 수'],
      ['singleN','단독 야간','앞뒤가 야간이 아닌 하루짜리 야간'], ['nightRange','야간 횟수 차이','야간을 가장 많이 선 사람과 가장 적게 선 사람의 차이'], ['weekendRange','주말·공휴일 차이','주말·공휴일 근무 일수의 최대−최소'],
      ['v','연차(V)','자동으로 넣은 연차 수'], ['relaxed','풀린 사전입력','완화로 바뀐 사전입력 칸 수'], ['gap','최고와의 차이(%)','가능한 최고 점수와의 차이 — 방향이 다르면 점수 기준도 달라 표끼리 견주는 값은 아닙니다']]; },
    // 그 열에서 가장 좋은(작은) 값인가 — 모두 같으면 표시하지 않는다
    multiBest(key, R){ const vals=this.multi.results.filter(x=>x.stats).map(x=>x.stats[key]).filter(x=>x!=null); if(key==='gap'||!R.stats||vals.length<2) return false;
      const min=Math.min(...vals); return R.stats[key]===min && vals.some(x=>x!==min); },
    // 고른 표를 화면에 연다 — 한 장 만들기가 끝났을 때와 같은 상태로 두고 이 달 자동저장본으로 삼는다
    multiPick(i){
      const R=this.multi.results[i]; if(!R||!R.result||!R.result.success||this.generating) return;
      const r=R.result;
      this.verClear(); this._showResult(r);
      this.solverLogs=String(R.log||'').split('\n').filter(Boolean).map((m, k)=>({id:k+1, msg:m})); this._logSeq=this.solverLogs.length; this._solveReset(); for(const l of this.solverLogs) this._solveFeed(l.msg);
      this.genRound=1; this.genElapsedBase=0; this.genRounds=[]; this.generateFinalElapsed=R.sec||0;
      this.rdDoneAt=new Date(); this.activeTab='schedule'; this._setContBase(R.payload, r); this.multi.picked=i; this.mk.open=false; this.genFirst=null; this.loadedSavedId=null;
      this._autoSaveSchedule(); this.toast(`'${R.label}' 표를 열었습니다 — 다른 표는 '여러 개 만들기'에서 다시 고를 수 있어요`, 'info', 5000);
    },
    // ── 공평성 리포트 (결정 1-90) — 간호사에게 보여 줄 수 있는 한 장: 이번 달과 직전 석 달의 야간·주말·공휴일 근무, 쉬는 날, 원티드 반영.
    //    요약 탭의 집계(nurseSummaryData)를 그대로 쓴다. ※ 는 공평 배분 대상이 아닌 사람(나이트킵·신규·임산부 등) ──
    fairReport: {open:false},
    get rdFairRows(){
      return (this.nurseSummaryData||[]).filter(r=>(r.total+r.rest+r.leave)>0).map(r=>{
        let want=0, kept=0;
        for(const d of (this.scheduleDays||[])) if(this.isWanted(r.id, d)){ want++; if(!this.isRelaxed(r.id, d)) kept++; }
        return {...r, want, kept};
      });
    },
    rdFairCols(){ return [['이름', r=>r.name+(r.group?` (${r.group})`:''), 'left'], ['야간', r=>r.n], ['지난 석 달 야간', r=>r.cumNights||0], ['야간 합', r=>(r.exclN?'※ ':'')+r.totalNights],
      ['주말·공휴일 근무', r=>r.wh], ['지난 석 달', r=>r.cumWh||0], ['주말·공휴일 합', r=>(r.exclW?'※ ':'')+r.totalWh], ['휴무', r=>r.rest], ['휴가', r=>r.leave], ['1오프', r=>r.isolatedOff], ['가장 긴 연속 휴무', r=>r.maxOffRun+'일'],
      ['원티드 반영', r=>r.want ? `${r.kept} / ${r.want}` : '—']]; },
    get rdFairNote(){ const f=(this.nurseSummaryData||[])[0]?.fair;
      return (f ? `대상자 가운데 야간 합의 차이 ${f.rangeN}회(최소 ${f.minN} ~ 최대 ${f.maxN}) · 주말·공휴일 합의 차이 ${f.rangeW}일(최소 ${f.minW} ~ 최대 ${f.maxW}). ` : '')+'※ 는 공평 배분 대상이 아닌 사람(나이트킵·신규·임산부·달 중간 전입·전출 등)입니다. 합 = 이번 달 + 지난 석 달.'; },
    _fairCanvas(){
      const cols=this.rdFairCols(), rows=this.rdFairRows, K=2, PAD=18, TITLE=36, HH=40, RH=26, FONT="'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
      const widths=cols.map((c, i)=>i===0 ? 150 : 88), W=PAD*2+widths.reduce((a, b)=>a+b, 0), noteH=44, H=PAD*2+TITLE+HH+RH*rows.length+noteH;
      const cv=document.createElement('canvas'); cv.width=W*K; cv.height=H*K; const g=cv.getContext('2d'); g.scale(K, K); g.fillStyle='#FFFFFF'; g.fillRect(0, 0, W, H); g.textBaseline='middle';
      const text=(s, x, y, w, h, {color='#111', size=12, bold=false, align='center'}={})=>{ g.fillStyle=color; g.font=`${bold?'700 ':''}${size}px ${FONT}`; g.textAlign=align; g.fillText(String(s), align==='left' ? x+8 : x+w/2, y+h/2+.5); };
      text(`${this.year}년 ${this.month}월 ${this.rdWard} 공평성 리포트`, PAD, PAD, W-PAD*2, TITLE, {size:16, bold:true, align:'left'});
      let x=PAD; const y0=PAD+TITLE;
      cols.forEach((c, i)=>{ g.fillStyle='#F4F5F7'; g.fillRect(x, y0, widths[i], HH); g.strokeStyle='#9AA1AC'; g.lineWidth=.5; g.strokeRect(x+.25, y0+.25, widths[i]-.5, HH-.5);
        const words=c[0].split(' '), two=c[0].length>7&&words.length>1, a=two ? words.slice(0, Math.ceil(words.length/2)).join(' ') : c[0], b=two ? words.slice(Math.ceil(words.length/2)).join(' ') : '';
        text(a, x, y0+(b?-8:0), widths[i], HH, {size:11, bold:true}); if(b) text(b, x, y0+8, widths[i], HH, {size:11, bold:true}); x+=widths[i]; });
      rows.forEach((r, k)=>{ let xx=PAD; const y=y0+HH+RH*k;
        cols.forEach((c, i)=>{ g.fillStyle=[3,6].includes(i) ? '#FFF7CC' : '#FFFFFF'; g.fillRect(xx, y, widths[i], RH); g.strokeStyle='#C9CED6'; g.lineWidth=.5; g.strokeRect(xx+.25, y+.25, widths[i]-.5, RH-.5);
          text(c[1](r), xx, y, widths[i], RH, {align:c[2]||'center', bold:[3,6].includes(i)}); xx+=widths[i]; }); });
      g.strokeStyle='#111'; g.lineWidth=1.5; g.strokeRect(PAD, y0, W-PAD*2, HH+RH*rows.length);
      const note=this.rdFairNote, yN=y0+HH+RH*rows.length+6; g.fillStyle='#4A5160'; g.font=`11px ${FONT}`; g.textAlign='left';
      let line='', ln=0; for(const w of note.split(' ')){ if(g.measureText(line+w).width>W-PAD*2-8){ g.fillText(line, PAD+2, yN+10+ln*16); line=''; ln++; } line+=w+' '; } g.fillText(line, PAD+2, yN+10+ln*16);
      return cv;
    },
    _canvasBlob(cv){ return new Promise((res, rej)=>cv.toBlob(b=>b ? res(b) : rej(new Error('그림을 만들지 못했습니다')), 'image/png')); },
    async fairCopy(){ try{ await navigator.clipboard.write([new ClipboardItem({'image/png':this._canvasBlob(this._fairCanvas())})]); this.toast('공평성 리포트 그림을 복사했습니다 — 채팅창에서 붙여넣기(Ctrl+V)하세요', 'success', 5000); }catch(e){ this.toast('그림을 복사하지 못했습니다 — 그림 파일로 저장해 보내 주세요', 'error'); } },
    async fairSave(){ const url=URL.createObjectURL(await this._canvasBlob(this._fairCanvas())), a=document.createElement('a'); a.href=url; a.download=`공평성_리포트_${this.year}년${this.month}월.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url); },

    // ── 근무 교환 검사 (결정 1-90) — 두 사람이 고른 날의 근무를 맞바꾸면 무엇이 새로 걸리는지 미리 본다. 서버가 바꾸기 전·뒤의 표를
    //    각각 규칙과 견주고(/api/check_schedule), 뒤에만 있는 것이 '새로 생기는 문제', 앞에만 있는 것이 '없어지는 문제'. 자격은 화면에서 본다 ──
    swap: {open:false, a:'', b:'', days:[], busy:false, res:null, seq:0},
    swapOpen(nid, day){ this.swap={open:true, a:nid||'', b:'', days:day ? [this.dayKey(day)] : [], busy:false, res:null, seq:this.swap.seq+1}; this.shiftEdit.open=false; },
    get swapDays(){ return (this.scheduleDays||[]).filter(d=>!this.isPrevMonthDay(d)); },
    swapCode(nid, dk){ return nid ? ((this.schedule?.[nid]||{})[dk]||'') : ''; },
    swapToggleDay(dk){ const s=this.swap; s.days=s.days.includes(dk) ? s.days.filter(x=>x!==dk) : [...s.days, dk].sort(); this.swapCheck(); },
    get swapPairs(){ const s=this.swap; return (s.a&&s.b) ? s.days.map(dk=>({dk, a:this.swapCode(s.a, dk), b:this.swapCode(s.b, dk)})) : []; },
    _swapTable(){ const s=this.swap, t=JSON.parse(JSON.stringify(this.schedule||{})); t[s.a]=t[s.a]||{}; t[s.b]=t[s.b]||{};
      for(const p of this.swapPairs){ if(p.b) t[s.a][p.dk]=p.b; else delete t[s.a][p.dk]; if(p.a) t[s.b][p.dk]=p.a; else delete t[s.b][p.dk]; } return t; },
    // 자격 — 받을 근무가 그 사람의 가능 근무에 있는가 (쉬는 날은 누구나) · 그 날 병동에 있는 사람인가 (전입 전·전출 후)
    _swapCapable(){ const s=this.swap, out=[], nm=id=>(this.nurses.find(n=>n.id===id)||{}).name||'';
      for(const p of this.swapPairs){ const day=this.swapDays.find(d=>this.dayKey(d)===p.dk); if(!day) continue;
        for(const id of [s.a, s.b]){ const n=this.nurses.find(x=>x.id===id), inact=n&&this.isNurseInactive(n, day); if(inact) out.push(`${nm(id)} — ${p.dk.slice(5).replace('-', '/')}은 ${inact==='before'?'전입 전이라':'전출 후라'} 근무를 받을 수 없습니다`); } }
      const can=(id, code)=>{ const sh=this.shiftMap.get(code); if(!code||!sh||['rest','leave'].includes(sh.period)) return true; const n=this.nurses.find(x=>x.id===id)||{}; return !n.capable_shifts||n.capable_shifts.includes(code)||n.capable_shifts.includes({DC:'D',EC:'E',NC:'N'}[code]); };   // 차지 코드는 바탕 근무로 본다
      for(const p of this.swapPairs){ const d=p.dk.slice(5).replace('-', '/'); if(!can(s.a, p.b)) out.push(`${nm(s.a)} — ${d} ${p.b} 근무를 할 수 없는 사람입니다 (명부의 가능 근무)`); if(!can(s.b, p.a)) out.push(`${nm(s.b)} — ${d} ${p.a} 근무를 할 수 없는 사람입니다 (명부의 가능 근무)`); }
      return out; },
    // 그룹 인원(한 근무 최대·최소 n명)은 화면이 센다 — 바꾼 표를 잠깐 끼워 세고 바로 되돌린다
    //    그룹 경고는 '못 지킨 근무 N개 — 목록' 한 줄이라, 같은 규칙끼리 개수로 견준다 (글이 조금만 달라도 새 문제로 보이지 않게)
    _swapGroupNotes(table){ const cur=this.schedule, out={}; try{ this.schedule=table;
        for(const w of this.groupWarnings()){ const text=(w.nurse?w.nurse+': ':'')+w.msg, head=text.split(' — ')[0], m=head.match(/(\d+)개$/); out[head.replace(/\d+개$/, '')]={n:m?+m[1]:1, text, head}; }
        return out; } finally{ this.schedule=cur; } },
    _swapGroupDiff(before, after){ const added=[], removed=[];
      for(const k in after){ const a=after[k], b=before[k]; if(!b) added.push(a.text); else if(a.n>b.n) added.push(a.text.replace(' — ', ` (지금은 ${b.n}개) — `)); else if(a.n<b.n) removed.push(`${a.head} (지금은 ${b.n}개)`); }
      for(const k in before) if(!after[k]) removed.push(before[k].head+' → 0개');
      return {added, removed}; },
    // 바꾸면 사라지는 원티드·잠근 칸 — 막지 않고 알린다
    _swapWanted(){ const s=this.swap, out=[], nm=id=>(this.nurses.find(n=>n.id===id)||{}).name||'';
      for(const p of this.swapPairs){ if(p.a===p.b) continue; const day=this.swapDays.find(d=>this.dayKey(d)===p.dk); if(!day) continue;
        for(const [id, code] of [[s.a, p.a], [s.b, p.b]]){ const d=p.dk.slice(5).replace('-', '/');
          if(this.isLocked(id, day)) out.push(`${nm(id)} — ${d} ${code}는 잠근 칸입니다`); else if(this.isWanted(id, day)) out.push(`${nm(id)} — ${d} ${code}는 원티드입니다`); }
        // 차지(DC/EC/NC)를 명부에 차지로 두지 않은 사람이 받는다 — 엔진도 차지가 없으면 승격시키므로 막지 않고 알린다
        for(const [id, got] of [[s.a, p.b], [s.b, p.a]]) if(['DC','EC','NC'].includes(got) && !(this.nurses.find(n=>n.id===id)||{}).is_charge) out.push(`${nm(id)} — ${p.dk.slice(5).replace('-', '/')} ${got}(차지)를 받습니다. 명부에는 차지로 되어 있지 않습니다`); }
      return out; },
    async swapCheck(){
      const s=this.swap; s.res=null; if(!s.a||!s.b||s.a===s.b||!s.days.length) return;
      if(this.swapPairs.every(p=>p.a===p.b)){ s.res={same:true, added:[], removed:[], capable:[], wanted:[]}; return; }
      const seq=++s.seq; s.busy=true;
      try{ const base={...this._basePayload()}, [before, after]=await Promise.all([this.api('POST', '/api/check_schedule', {...base, schedule:this.schedule}), this.api('POST', '/api/check_schedule', {...base, schedule:this._swapTable()})]);
        if(seq!==this.swap.seq) return;
        const b=new Set(before.notes||[]), a=new Set(after.notes||[]), g=this._swapGroupDiff(this._swapGroupNotes(this.schedule), this._swapGroupNotes(this._swapTable()));
        s.res={added:[...[...a].filter(x=>!b.has(x)), ...g.added], removed:[...[...b].filter(x=>!a.has(x)), ...g.removed], capable:this._swapCapable(), wanted:this._swapWanted()};
      }catch(e){ if(seq===this.swap.seq) s.res={error:'검사하지 못했습니다 — '+(e.message||'서버 오류')}; }
      finally{ if(seq===this.swap.seq) s.busy=false; }
    },
    swapApply(){
      const s=this.swap; if(!s.res||s.res.error||s.res.same||!this.swapPairs.length) return;
      this._schedPush(); const t=this._swapTable(); this.schedule={...this.schedule, [s.a]:t[s.a], [s.b]:t[s.b]}; this.rdSaved=false; this.checkScheduleViolations();
      const nm=id=>(this.nurses.find(n=>n.id===id)||{}).name||''; this.toast(`${nm(s.a)} ↔ ${nm(s.b)} ${s.days.length}일 근무를 바꿨습니다 — 되돌리려면 Ctrl+Z`, 'success', 5000); s.open=false;
    },

    // 이어 찾는 동안의 중간 결과 한 줄 — 화면의 표가 어느 정도인지·몇 개를 찾았는지·모두 얼마나 걸렸는지 (찾기가 바뀌어도 처음부터 다시 세지 않는다)
    get rdMidFacts(){
      if(!(this.generating && this.rdSched)) return [];      // 첫 찾기에서도 찾는 도중의 표가 뜨면 보인다 (결정 1-97)
      const g=this.mipGapPercent, S=this.solveStats, sec=(this.genElapsedBase||0)+(this.generateElapsed||0);
      return [['지금 화면의 표', this.verCur!=null&&this.verLog.length ? `${this.verCur}번`+(g==null ? '' : (g>=100 ? ' · 가능한 최고와 차이 큼' : ` · 가능한 최고와 ${Math.round(g*100)/100}% 차이`)) : (g==null ? '저장해 둠' : `가능한 최고와 ${Math.round(g*100)/100}% 차이`)],
        ['지금까지 찾은 표', `${(S&&S.found)||0}개`], ...(this.genRound>1 ? [['이어 찾기', `${this.genRound-1}번째`]] : []), ['처음부터', sec>=60 ? `${Math.floor(sec/60)}분 ${sec%60}초` : `${sec}초`]];
    },
    // 근무표 탭에서 칸 창을 닫으면 선택을 지운다 — 끌어 고르는 중(_isDragging)에는 두고, 사전입력 탭의 선택(키보드 입력용)은 건드리지 않는다
    rdPopClosed(){ if(this.activeTab==='schedule' && this._sel && this._sel.tab==='schedule' && !this._isDragging) this._sel=null; },
    // 저장한 근무표를 불러왔음을 알린다 (결정 1-88) — 알림 한 줄 + 표가 한 번 떠오르는 움직임 + 목록에서 그 줄에 '열려 있음'
    loadedSavedId: null, tableFlash: false,
    rdLoadedNotice(id, name){
      this.loadedSavedId=id; this.verAfterLoad(); this.toast(`‘${name||'근무표'}’를 불러왔습니다`, 'success', 3500);
      this.tableFlash=false; clearTimeout(this._flashT);
      const on=()=>{ this.tableFlash=true; this._flashT=setTimeout(()=>{ this.tableFlash=false; }, 900); };
      this.$nextTick ? this.$nextTick(on) : on();
    },
    get rdMakeLabel(){ return this.generating ? '만드는 중…' : (this.rdSched ? '다시 만들기' : '근무표 만들기'); },
    get rdMakeTip(){ return this.rdSched ? (this.rdPreChanged?'고친 사전입력으로 새로 만듭니다. ':'')+'몇 개 만들지와 방향을 고른 뒤 새로 만듭니다. 저장한 표는 불러오기에 남아 있어요.' : `몇 개 만들지와 방향을 먼저 고릅니다. 사전입력을 지키면서 자동으로 채웁니다. ${this.feas&&this.feas.estimated_seconds ? this.rdEta(this.feas.estimated_seconds)+' 걸리고' : '몇 분 걸리고'} 중간에 멈출 수 있어요.`; },

    // ── 되돌리기 토스트 ──
    rdUndoToast(msg, undo=true){
      clearTimeout(this._rdToastTimer);
      this.rdToast={msg, undo};
      this._rdToastTimer=setTimeout(()=>{ this.rdToast=null; }, 6000);
    },
    rdToastUndo(){ if(this.rdToast&&this.rdToast.undo) this.undo(); this.rdToast=null; clearTimeout(this._rdToastTimer); },

    // ── 파괴적 동작 2단 확인 ──
    rdArm(key){
      if(this.rdConfirmKey===key){ this.rdConfirmKey=null; clearTimeout(this._rdConfirmTimer); return true; }
      this.rdConfirmKey=key; clearTimeout(this._rdConfirmTimer);
      this._rdConfirmTimer=setTimeout(()=>{ this.rdConfirmKey=null; }, 3500);
      return false;
    },
    rdArmed(key){ return this.rdConfirmKey===key; },
    rdClearPrev(){ if(this.rdArm('clearPrev')) this.clearPrevSchedule(true); },
    rdDeleteNurse(){
      const id=this.nurseModal.data.id; if(!id||this.nurseModal.isNew) return;
      const armed=this._removeConfirmId===id;
      this.removeNurse(id).then(()=>{ if(armed) this.nurseModal.open=false; });
    },

    // ── 숫자 ± ──
    bumpReq(key, shift, delta){
      if(!this.requirements[key]) this.requirements[key]={};
      const v=Math.max(0, Math.min(20, (parseInt(this.requirements[key][shift])||0)+delta));
      this.requirements[key][shift]=v;
    },
    bumpRule(field, delta, min, max){
      const v=Math.max(min, Math.min(max, (parseInt(this.rules[field])||0)+delta));
      this.rules[field]=v;
    },
    bumpTimeout(delta){ this.generateTimeout=Math.max(1, Math.min(60, (parseInt(this.generateTimeout)||20)+delta)); },

    // ── 셀 팝업 ──
    get rdPopCodes(){
      const mode=this.shiftEdit.mode;
      let codes=this.getEditShifts();
      if(mode==='prev') codes=this.prevShifts;   // 차지(DC·EC·NC)는 뺀다 — D·E·N 을 넣으면 그날 차지는 엔진이 자격·시니어리티로 정한다
      const trainee=this.shiftEdit.mode==='prev' && this.shiftEdit.nurse && this.isTraineeInTraining(this.shiftEdit.nurse, this.shiftEdit.day);
      if(trainee) codes=this.traineeShifts;
      const bare=c=>c.replace(/^\//,'');
      const work=[], rest=[];
      for(const c of codes){ const s=this.shiftMap.get(bare(c)); const p=s?s.period:''; (['day','day1','evening','middle','night'].includes(p)?work:rest).push(c); }
      const ord=(arr,order)=>arr.sort((a,b)=>{ const ia=order.indexOf(bare(a)), ib=order.indexOf(bare(b)); return (ia<0?99:ia)-(ib<0?99:ib); });
      // 원티드 '둘 중 하나'·'N 빼고'는 사전입력에만 (근무표 칸은 한 근무여야 한다 · 신규는 프리셉터를 따른다)
      const fine=(mode==='prev'||mode==='prev_multi') && !trainee;
      return {work:ord(work,WORK_ORDER), rest:ord(rest,REST_ORDER), fine};
    },
    // 세부 원티드 — 지금 켜져 있는 것. 빈칸은 넷 다, 묶음 코드는 그 묶음, 그 밖의 코드는 그 시간대 하나.
    // 여러 칸은 값이 모두 같을 때만 그 값으로 읽고, 섞였으면 빈칸처럼 넷 다 켠 데서 시작한다
    get rdFineOn(){
      const se=this.shiftEdit; if(!se.nurse||!se.day) return '';
      const cells=se.mode==='prev_multi' ? this._dragCells : [{nid:se.nurse.id, dk:this.dayKey(se.day)}];
      const codes=[...new Set(cells.map(c=>(this.prevSchedule[c.nid]?.[c.dk]||'').replace(/^법$/,'OF')))];   // 공휴일의 '휴무'는 법으로 적힌다 (_fineRest)
      const code=codes.length===1 ? codes[0] : ''; if(!code) return 'DENR';
      const key=Object.keys(FINE).find(k=>FINE[k]===code); if(key) return key;
      const p=this.shiftMap.get(code.replace(/^\//,''))?.period;
      return {day:'D', evening:'E', night:'N', rest:'R', leave:'R'}[p]||'';
    },
    rdFineToggle(k){
      const on=this.rdFineOn, code=FINE[['D','E','N','R'].filter(x=>(x===k)!==on.includes(x)).join('')];
      if(!code) return;   // 다 끄면 놓을 것이 없다 — 마지막 하나는 켜 둔다
      const se=this.shiftEdit, cells=se.mode==='prev_multi' ? this._dragCells : [{nid:se.nurse.id, dk:this.dayKey(se.day)}];
      this._gridWrite('preinput', cells.map(c=>({nid:c.nid, dk:c.dk, code:this._fineRest(c.nid,c.dk,code)})));   // 팝업은 그대로 — 이어서 더 켜고 끈다
    },
    // '휴무'만 켠 칸이 이번 달 법정공휴일이면 법 — 공휴일의 OF 는 엔진이 버려(_holiday_of_banned) 쉬는 날로 남지 않는다.
    // 나이트킵은 법을 받지 못해 OF 그대로, 지난달 칸은 기록이라 그대로 (엔진과 같은 기준)
    _fineRest(nid,dk,code){
      if(code!=='OF'||!this.holidays.includes(dk)||dk<this.dayKey(new Date(this.year,this.month-1,1))) return code;
      const n=this.nurses.find(x=>x.id===nid);
      return n&&this.isKeeperDay(n,new Date(dk+'T00:00:00')) ? code : '법';
    },
    // 명부에서 그 시간대 근무를 하나도 못 하는 간호사면 그 단추는 꺼진 채 잠근다 (엔진도 배정하지 않는다)
    rdFineCan(k){
      const n=this.shiftEdit.nurse, p={D:'day', E:'evening', N:'night'}[k]; if(!p||!n?.capable_shifts) return true;
      return n.capable_shifts.some(c=>this.shiftMap.get(c)?.period===p);
    },
    // 팝업에서 바로 적는 메모 — 글자마다 저장하고, 되돌리기는 한 번 들어와 적는 동안 한 번만 쌓는다
    rdPopNote(text){
      const se=this.shiftEdit; if(se.mode!=='prev'||!se.nurse||!se.day) return;
      const nid=se.nurse.id, dk=this.dayKey(se.day);
      if((this.cellNotes[nid]?.[dk]||'')===text) return;
      if(!this._noteUndone){ this._pushUndo(); this._noteUndone=true; }
      if(text.trim()) (this.cellNotes[nid]=this.cellNotes[nid]||{})[dk]=text;
      else if(this.cellNotes[nid]){ delete this.cellNotes[nid][dk]; if(!Object.keys(this.cellNotes[nid]).length) delete this.cellNotes[nid]; }
    },
    get rdPopCurrent(){
      const n=this.shiftEdit.nurse, d=this.shiftEdit.day; if(!n||!d||this.shiftEdit.mode==='prev_multi'||this.shiftEdit.mode==='sched_multi') return '';
      return this.shiftEdit.mode==='prev' ? this.getPrevShift(n.id, d) : (this._getShift(n.id, d)||'');
    },
    rdPlacePopup(){
      const se=this.shiftEdit; if(!se.open||!se.nurse||!se.day) return;
      this.$nextTick(()=>{
        const nid=se.nurse.id||se.nurse.nid; const iso=this.dayKey(se.day);
        const el=document.querySelector(`.rd-screen:not([style*="display: none"]) [data-cell="${nid}|${iso}"]`)||document.querySelector(`[data-cell="${nid}|${iso}"]`);
        if(!el){ this.cellPop={left:24, top:96}; return; }
        // 팝업은 position:fixed — 칸의 뷰포트 좌표 기준 오른쪽에, 안 들어가면 왼쪽에, 아래가 모자라면 위로 올린다
        // 높이는 실제 팝업에서 잰다 — 사전입력 팝업은 원티드 줄이 더 있어 근무표 팝업보다 길다
        const pop=document.querySelector('[data-rd=cell-popup]');
        let r=el.getBoundingClientRect();
        if(se.anchorEnd){   // 여러 칸 — 고른 범위 전체를 피한다
          const e2=[...document.querySelectorAll(`[data-cell="${se.anchorEnd.nid}|${se.anchorEnd.dk}"]`)].find(x=>x.offsetParent);
          if(e2){ const b=e2.getBoundingClientRect(); r={left:Math.min(r.left,b.left), right:Math.max(r.right,b.right), top:Math.min(r.top,b.top), bottom:Math.max(r.bottom,b.bottom)}; }
        }
        const W=372, H=Math.min(Math.max(pop?.offsetHeight||0, 470), window.innerHeight-16);
        let left=r.right+8, top=r.top-8;
        if(left+W>window.innerWidth-8) left=r.left-W-8;
        if(left<8) left=8;
        if(top+H>window.innerHeight-8) top=Math.max(8, window.innerHeight-H-8);
        this.cellPop={left:Math.round(left), top:Math.round(top)};
      });
    },
    // 고급 팝업(툴바 고급 단추 아래, position:absolute)이 창 밖으로 나가지 않게 — 오른쪽이 넘치면 그만큼 왼쪽으로 당기고
    // (1024 폭에선 오른쪽이 잘렸다), 높이는 창 아래까지로 줄여 안에서 스크롤 (접힌 조절을 펼쳐도 그 안에서)
    rdFitPop(el){
      if(!el || !el.offsetParent) return;
      el.style.left=''; el.style.maxHeight='';
      const r=el.getBoundingClientRect(), M=16;
      const over=r.right-(window.innerWidth-M);
      if(over>0) el.style.left=`${-Math.round(Math.min(over, Math.max(0, r.left-M)))}px`;
      el.style.maxHeight=`${Math.max(240, Math.floor(window.innerHeight-r.top-M))}px`;
    },
    // ── 표 가독성 (2026-10-19) ──
    // 그룹(A·B·C)이 바뀌는 줄 — 굵은 가로선으로 묶음을 나눈다
    rdGroupStart(list, i){ return i>0 && (list[i-1]?.group||'')!==(list[i]?.group||''); },
    // 팀 색 — 이름 칸 바탕(화면·엑셀). 고른 색은 rules.teamColors, 고르지 않은 팀은 명부에 처음 나오는 순서로 병동 번표 색을 돌려 쓴다
    get teamColorMap(){
      const pal=['#DDEBF7','#FFF2CC','#E2F0D9','#FCE4D6','#E4DFEC','#D9D9D9'], own=this.rules?.teamColors||{}, m={};
      for(const n of this.nurses) if(n.group && !(n.group in m)) m[n.group]=own[n.group]||pal[Object.keys(m).length%pal.length];
      return m;
    },
    // 이름 칸 :style — 어두운 색을 고르면 글씨를 희게 (서버 엑셀과 같은 산식)
    rdTeamStyle(nurse){
      const c=this.teamColorMap[nurse.group]; if(!c) return '';
      const v=parseInt(c.slice(1),16), dark=(v>>16)*299+(v>>8&255)*587+(v&255)*114<140000;
      return `--team-bg:${c};--team-fg:${dark?'#FFFFFF':'#1A1A1A'}`;
    },
    async setTeamColor(team, hex){
      const prev=this.rules.teamColors||{};
      this.rules.teamColors={...prev,[team]:hex};
      try{ await this.api('POST','/api/rules',{teamColors:this.rules.teamColors}); }
      catch(e){ this.rules.teamColors=prev; this.toast(e.message||'팀 색을 저장하지 못했습니다','error'); }
    },
    // 마우스가 있는 칸의 날짜 머리를 표시 — 표가 넓어 위 날짜를 찾기 어려웠다. 움직일 때마다 표를 다시 그리지 않게 Alpine 상태 대신 DOM 클래스
    rdHoverCol(e, leave){
      const tbl=e?.currentTarget?.closest('table'); if(!tbl) return;
      const td=leave?null:e.target.closest?.('td[data-cell]'); const dk=td?td.dataset.cell.split('|')[1]:'';
      if(tbl.dataset.hoverDk===dk) return;
      tbl.querySelectorAll('th.rt-day.is-hover').forEach(th=>th.classList.remove('is-hover'));
      if(dk) tbl.querySelector(`th.rt-day[data-dk="${dk}"]`)?.classList.add('is-hover');
      tbl.dataset.hoverDk=dk;
    },
    // 날짜 칸 너비 — 앞뒤 주까지 한 달(35~42칸)이 옆으로 넘기지 않고 한 화면에 들어가게 늘 맞춘다.
    // 칸 너비 = (표 영역 − 이름 칸 − 합계 칸) / 날 수, 28px ~ 토큰 값(--col-w). 표는 내용 폭이라 남는 폭은 오른쪽에 비워 둔다
    rdFitColumnsSoon(){ clearTimeout(this._fitTimer); this._fitTimer=setTimeout(()=>this.rdFitColumns(), 30); },
    rdFitColumns(){
      const max=parseInt(getComputedStyle(document.documentElement).getPropertyValue('--col-w'))||38;
      for(const wrap of document.querySelectorAll('.rtable-wrap')){
        const tbl=wrap.querySelector(':scope > .rtable');
        if(!tbl||!wrap.clientWidth) continue;   // 숨은 탭 — 보일 때 다시 잰다
        const name=tbl.querySelector('.rt-name-h')?.offsetWidth||148;
        const sums=[...tbl.querySelectorAll('.rt-sum-h')].reduce((a,th)=>a+(th.offsetParent?th.offsetWidth:0),0);
        const days=(this.scheduleDays||[]).length||1;
        wrap.style.setProperty('--col-w', Math.max(28, Math.min(max, Math.floor((wrap.clientWidth-name-sums-2)/days)))+'px');
      }
    },
    rdPopPick(code){ this.applyShiftEditWithUndo(code); },   // 여러 칸이면 applyMultiShiftEdit 로
    rdCellTipPre(nurse, day){
      const inact=this.isNurseInactive(nurse, day); if(inact) return inact==='before' ? '전입 전 — 배정하지 않습니다' : '전출 후 — 배정하지 않습니다';
      const code=this.getPrevShift(nurse.id, day); const m=day.getMonth()+1, d=day.getDate();
      let t=code ? `${nurse.name} · ${m}월 ${d}일 ${code}(${this.rdCodeName(code)}) — 클릭해 바꾸거나 잠금·메모` : `${nurse.name} · ${m}월 ${d}일 — 클릭해 근무 선택 · 빈칸은 자동 배정`;
      if(this.isLocked(nurse.id, day)) t+=' · 잠긴 칸';
      if(!code && this.hasWish(nurse.id, day)) t+=' · 희망 '+this.getWish(nurse.id, day);
      const note=this.getNote(nurse.id, day); if(note) t+='\n'+note;   // 줄바꿈 뒤는 메모 — 풍선말이 크게 따로 그린다
      return t;
    },
    rdCellTipSched(nurse, day){
      const inact=this.isNurseInactive(nurse, day); if(inact) return inact==='before' ? '전입 전' : '전출 후';
      const code=this.displayShift(nurse.id, day); const m=day.getMonth()+1, d=day.getDate();
      let t=`${nurse.name} · ${m}월 ${d}일 ${code||'(빈칸)'} — 클릭해 고치기`;
      if(this.isLocked(nurse.id, day)) t+=' · 잠긴 칸';
      if(this.rdIsPre(nurse.id, day)) t+=' · 사전입력에서 넣은 칸';
      if(this.isRelaxed(nurse.id, day)) t+=` · 사전입력 ${this.relaxedCells[nurse.id][this.dayKey(day)].original}에서 바뀜`;
      const note=this.getNote(nurse.id, day); if(note) t+='\n'+note;
      return t;
    },

    // ── 요일별 인원 / 규칙 표시 ──
    rdReqVal(key, shift){ return (this.requirements[key]||{})[shift]||0; },
    rdFootNeed(day, code){ const r=this.getPrevDayReq(day, code); return (r!==null&&r!==undefined) ? r : this.getDefaultDayReq(day, code); },
    // 날짜별 필요 인원 (설정 달력) — 이 달 표 주기 안에서 요일 기본값과 다르게 둔 날 수 · 모두 되돌리기
    get rdDayReqCount(){ const keys=this._cycleDateKeys(); return Object.keys(this.prevDayReqs||{}).filter(k=>keys.has(k)).length; },
    rdResetDayReqs(){
      if(!this.rdArm('dayReqs')) return;
      this._pushUndo(); const keys=this._cycleDateKeys();
      for(const k of Object.keys(this.prevDayReqs)) if(keys.has(k)) delete this.prevDayReqs[k];
      this._checkViolations();
    },
    // 근무표 칸이 사전입력에서 온 그대로인가 — 완화로 바뀌었거나 손으로 고친 칸은 뺀다 (모서리 표시)
    // 원티드 색을 칠할 칸 — 사전입력 값이 있는 칸. 주휴(주)와 지난달 근무표의 칸(isCarryDay)은 뺀다.
    // 끝에 붙은 다음 달 며칠(12월 표의 1/1·1/2)은 이 표가 만드는 칸이라 칠한다 — 빼 두면 그 칸만 화면·엑셀에 표식이 없었다 (결정 1-75)
    isWanted(nid, day){
      const c=this.getPrevShift(nid, day); return !!c && c!=='주' && !this.isCarryDay(day) && !this.isNotWanted(nid, day);
    },
    // 원티드가 아닌 사전입력 (결정 1-84) — 사전입력은 번표를 짜는 사람이 넣는다: 간호사가 낸 원티드 + 짜는 사람이 따로 챙겨 넣은 칸.
    // 뒤쪽은 칸마다 '원티드 아님'으로 표시해 원티드 색·원티드 수에서 뺀다. 넣어 둔 값이 바뀌면 표시는 저절로 풀린다(그때 값을 적어 둔다).
    // 엔진에는 보내지 않는다 — 사전입력으로 지키는 것은 같다
    isNotWanted(nid, day){ const c=this.getPrevShift(nid, day); return !!c && this.notWanted?.[nid]?.[this.dayKey(day)]===c; },
    rdCanMarkWanted(nid, day){ const c=nid&&day ? this.getPrevShift(nid, day) : ''; return !!c && c!=='주' && !this.isCarryDay(day); },
    toggleNotWanted(nid, day){
      if(!this.rdCanMarkWanted(nid, day)) return;
      const dk=this.dayKey(day), row={...(this.notWanted[nid]||{})};
      if(this.isNotWanted(nid, day)) delete row[dk]; else row[dk]=this.getPrevShift(nid, day);
      const all={...this.notWanted}; if(Object.keys(row).length) all[nid]=row; else delete all[nid];
      this.notWanted=all; this._saveFullState&&this._saveFullState();
    },
    // 지난달 근무표의 칸 — 앞 달에서 시작한 첫 주기(7일) 전체: 지난달 날짜와 그 주의 이번 달 날짜(12월이면 11/29~12/5).
    // 완화를 켜도 바뀌지 않는다 (엔진 _carry_week_keys + '지난달 칸' 고정과 같은 범위)
    isCarryDay(day){ const s=this.scheduleDays[0]; return !!s && this.isOverflow(s) && Math.round((day-s)/86400000)<7; },
    isPrevMonthDay(day){ return day<new Date(this.year, this.month-1, 1); },
    rdIsPre(nid, day){ return !!this.getPrevShift(nid, day) && !this.isRelaxed(nid, day) && !this.isManuallyEdited(nid, day); },
    // 사전입력 툴바의 다음 단계 단추 — 근무표가 없으면 넘어가서 바로 만들고, 있으면 보여 주기만 한다 (만든 표를 말없이 버리지 않는다)
    rdGoMake(){ this.activeTab='schedule'; if(!this.rdSched && !this.generating) this.makeOpen(); },

    // ── 간호사 모달 보조 ──
    rdWdays: ['일','월','화','수','목','금','토'],
    rdJuhuIs(i){ return this.nurseModal.data.juhu_day===i; },
    rdToggleJuhuDay(i){ this.nurseModal.data.juhu_day = this.nurseModal.data.juhu_day===i ? null : i; },
    rdMonthOn(m){ return !!(this.nurseModal.data.night_months||{})[`${this.year}-${String(m).padStart(2,'0')}`]; },
    rdToggleMonth(m){ this.toggleNightMonthModal(m, !this.rdMonthOn(m)); },
    rdCapable(s){ return !!(this.nurseModal.data.capable_shifts||[]).includes(s); },
    get rdSpecialSummary(){
      const d=this.nurseModal.data||{}; const p=[];
      if(d.is_trainee) p.push('신규간호사');
      if(d.is_pregnant) p.push('임산부');
      if(d.start_date||d.end_date) p.push('전입/전출');
      return p.length ? `— ${p.join(' · ')}` : '— 신규간호사 · 임산부 · 전입/전출 (해당 없음)';
    },
    rdSpecialOpen: false,
    nurseNote(nurse){
      const p=[];
      if(nurse.is_trainee){ const pr=this.nurses.find(n=>n.id===nurse.preceptor_id); p.push('신규'+(pr?' · 프리셉터 '+pr.name:'')); }
      if(nurse.is_pregnant) p.push('임산부 · 야간 제외');
      if(nurse.start_date) p.push(`${fmtMD(nurse.start_date)} 전입`);
      if(nurse.end_date) p.push(`${fmtMD(nurse.end_date)} 전출`);
      return p.join(' · ');
    },
    rdNk(nurse){
      const b=this.nightMonthsBadge(nurse);
      if(b.on) return {label:`${this.month}월 켜짐`, cls:'on', title:b.title};
      if(b.any){ const t=b.text.replace(' 야간전담','').replace(/월$/,'월만'); return {label:t, cls:'other', title:b.title}; }
      return {label:'—', cls:'', title:b.title};
    },

    // ── 인쇄 미리보기 ──
    get rdPrintDays(){ return (this.scheduleDays||[]).filter(d=>!this.isOverflow(d)); },
    // 병동 번표에는 누가 차지인지 나오지 않는다 (2026-10-03) — '차지 숨기기'와 상관없이 늘 D/E/N
    rdPrintCode(nurse, day){ const s=this._getShift(nurse.id, day); return (!s||s==='-') ? '' : this.plainShift(s); },
    rdDoPrint(){ document.body.classList.add('rd-printing'); setTimeout(()=>{ this.printSchedule(); setTimeout(()=>document.body.classList.remove('rd-printing'), 1500); }, 60); },
    get rdPrintMeta(){
      const today=new Date(); const ds=`${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      return `간호사 ${this.nurses.length}명 · 작성 ${ds} · D 06~14 · E 14~22 · N 22~06 · 주=주휴 · OF=오프 · V=연차`;
    },

    // ── 폰: 내 근무 · 오늘 근무자 ──
    setMyNurse(id){ this.myNurseId=id||''; try{ localStorage.setItem('ns_my_nurse', this.myNurseId); }catch(e){} },
    get rdMyShift(){
      const n=this.nurses.find(x=>x.id===this.myNurseId); if(!n) return null;
      const k=this.todayKey(); const code=(this.schedule?.[n.id]?.[k])||'';
      const s=this.shiftMap.get(code);
      const desc = code ? (({day:'낮',day1:'상근',evening:'저녁',middle:'중간번',night:'야간',rest:'휴무',leave:'휴가'})[s?.period]||'')+(s&&s.hours&&s.hours!=='-' ? ' '+s.hours.replace(/:00/g,'') : '') : '오늘 근무표에 없음';
      const nx=[]; const d=new Date();
      for(let i=1;i<=2;i++){ const t=new Date(d); t.setDate(d.getDate()+i); const c=(this.schedule?.[n.id]?.[this.dayKey(t)])||''; if(c) nx.push((i===1?'내일 ':'그다음 ')+c+' '+this.rdCodeName(c)); }
      return {name:n.name, code: code||'—', desc, next: nx.join(' · ')};
    },
    get rdTodayDuties(){
      return ['D','E','N'].map(duty=>{
        const rows=this.todayNursesByDuty(duty);
        return {code:duty, name: duty==='D'?'낮 06~14':duty==='E'?'저녁 14~22':'야간 22~06', count: rows.length+'명',
                people: rows.map(r=>({name:r.nurse.name, charge:['DC','EC','NC'].includes(r.code)}))};
      });
    },
    get rdTodayCount(){ return ['D','E','N'].reduce((a,d)=>a+this.todayNursesByDuty(d).length, 0); },
    get rdPhoneNurses(){ const list=this.filteredNurses; return this.myOnly && this.myNurseId ? list.filter(n=>n.id===this.myNurseId) : list; },

    // ── 커스텀 툴팁 (title 을 읽어 0.3초 뒤 표시, 포커스에도) ──
    _rdTipInit(){
      if(window._rdTipBound) return; window._rdTipBound=true;
      const tip=document.createElement('div'); tip.className='rtip'; tip.id='rd-tip'; tip.hidden=true; tip.setAttribute('role','tooltip'); document.body.appendChild(tip);
      let timer=null, cur=null;
      const fmt=t=>{ const nl=String(t).indexOf('\n'); if(nl>=0) return fmt(t.slice(0,nl))+'<span class="memo">'+esc(t.slice(nl+1))+'</span>';   // 칸 메모 — 줄바꿈 뒤
        const parts=String(t).trim().split(/(?<=[.。])\s+/).filter(Boolean); if(parts.length>=2){ const last=parts.pop(); return esc(parts.join(' '))+' <span class="note">'+esc(last)+'</span>'; } return esc(t); };
      const place=el=>{ const r=el.getBoundingClientRect(); tip.style.left='0px'; tip.style.top='0px'; const tw=Math.min(380, tip.offsetWidth||380);
        let left=r.left+window.scrollX-24; if(left+tw>window.innerWidth-12) left=window.innerWidth-12-tw; if(left<8) left=8;
        let top=r.bottom+window.scrollY+8; if(top+tip.offsetHeight>window.innerHeight+window.scrollY-8) top=r.top+window.scrollY-tip.offsetHeight-8;
        tip.style.left=left+'px'; tip.style.top=top+'px'; };
      // title 을 지우면 접근 가능한 이름·설명도 사라진다 (리뷰 2026-10-21) — 보이는 동안 옮겨 두고 닫을 때 넣은 것만 뺀다.
      // 이름이 title 뿐이면(아이콘 단추·라벨 없는 입력 칸) aria-label, 아니면 이 말풍선을 설명(aria-describedby)으로
      const named=el=>el.hasAttribute('aria-label')||el.hasAttribute('aria-labelledby')||el.labels?.length>0
        ||(!/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName)&&!!String(el.innerText??el.textContent??'').trim());   // 입력 칸의 글자(고르기 칸의 보기)는 이름이 아니다
      const show=el=>{ const t=el.getAttribute('title'); if(!t) return; const a=named(el)?'aria-describedby':'aria-label'; if(!el.hasAttribute(a)){ el.setAttribute(a, a==='aria-label'?t:tip.id); el.setAttribute('data-rd-tip-aria', a); } el.setAttribute('data-rd-tip', t); el.removeAttribute('title'); cur=el; tip.innerHTML=fmt(t); tip.hidden=false; place(el); };
      const hide=()=>{ clearTimeout(timer); timer=null; if(cur){ const t=cur.getAttribute('data-rd-tip'); if(t&&!cur.getAttribute('title')) cur.setAttribute('title', t); cur.removeAttribute('data-rd-tip'); const a=cur.getAttribute('data-rd-tip-aria'); if(a){ cur.removeAttribute(a); cur.removeAttribute('data-rd-tip-aria'); } } cur=null; tip.hidden=true; };
      document.addEventListener('mouseover', e=>{ const el=e.target.closest&&e.target.closest('[title]'); if(!el){ return; } if(el===cur) return; hide(); timer=setTimeout(()=>show(el), 300); });
      document.addEventListener('mouseout', e=>{ const el=e.target.closest&&e.target.closest('[title],[data-rd-tip]'); if(!el) return; if(e.relatedTarget&&el.contains(e.relatedTarget)) return; hide(); });
      document.addEventListener('focusin', e=>{ const el=e.target.closest&&e.target.closest('[title]'); if(!el) return; hide(); show(el); });
      document.addEventListener('focusout', ()=>hide());
      document.addEventListener('mousedown', ()=>hide(), true);
      document.addEventListener('keydown', e=>{ if(e.key==='Escape') hide(); });
      window.addEventListener('scroll', ()=>hide(), true);
    },

    // ── 검증용 상태 진입 (design/handoff/check) — 개발·검증에서만 쓴다 ──
    async rdApplyState(screen, state){
      if(this.profileScreen){ const g=(this.profiles||[]).find(p=>p.is_guest)||(this.profiles||[])[0]; if(g){ this.profilePasswordInput=''; await this.selectProfile(g); } }
      // 서버에 남은 직전 생성 결과 복원(_checkPendingGenerate, 비동기)이 픽스처보다 늦게 도착하면 상태를 덮어쓴다 — 먼저 끝나기를 기다린다
      try{ await this._checkPendingGenerate(); }catch(e){}
      if(this._recoverPoll){ clearInterval(this._recoverPoll); this._recoverPoll=null; }
      this.showOnboarding=false; this.showHelpModal=false; this.showShortcutHelp=false; this.showMobileMore=false; this.showPrintPreview=false;
      this.shiftEdit.open=false; this.pastePrev.open=false; this.nurseModal.open=false; this.noteEdit.open=false; this.juhuOptionModal.open=false;
      this.showSavedDrawer=false; this.signalPop=false; this.rdToast=null; this.rdMyPick=false; this.showGenAdvanced=false; this.tableFullscreen=false;
      this.year=2026; this.month=10; this.holidays=['2026-10-03','2026-10-09'];
      const fx=this._rdFixtures();
      const setPrev=filled=>{ this.prevSchedule=filled?fx.prev:{}; this.lockedCells=filled?fx.locks:{}; this.cellNotes=filled?fx.notes:{}; this.feas=filled?{status:'feasible',estimated_seconds:180,checking:false,anchored:[],conflicts:[]}:null; this.staffingAlerts=null; this.prevViolations=[]; this.prevPinNotes=[]; };
      const setSched=(kind)=>{
        this.generating=false; this.diagResult=null; this.fixResult=null; this.scheduleStopped=false; this.mipGapPercent=1.2;
        if(kind==='none'){ this.schedule={}; this.extendedSchedule={}; this.relaxedCells={}; this.statusMessage=''; this.statusOk=true; this._originalSchedule=null; this.showReports=false; return; }
        this.schedule=JSON.parse(JSON.stringify(fx.sched)); this.extendedSchedule={}; this.nurseScores={}; this.nurseScoreDetails={};
        this.relaxedCells={}; this.statusOk=true; this.statusMessage='근무표 생성 완료'; this.rdDoneAt=new Date(2026,8,28,14,2); this.rdSaved=true;
        this.offTeukgeun=[]; this.managerCheck=[]; this.vReport=null; this.wishReport=null; this.generationReport=null; this.solverLogs=[];
        this.trackEdits();
        for(const [nid,dk] of fx.edited){ this.schedule[nid][dk]= this.schedule[nid][dk]==='D' ? 'E' : 'D'; }
        this.lockedCells=fx.schedLocks;
        if(kind==='relaxed'){
          this.relaxedCells={};
          for(const r of fx.relax){ (this.relaxedCells[r.nid]=this.relaxedCells[r.nid]||{})[r.dk]={original:r.from, assigned:r.to}; this.schedule[r.nid][r.dk]=r.to; }
          this.cellNotes={[fx.relax[0].nid]:{[fx.relax[0].dk]:'이날 낮 인원이 1명 모자람'}};
          this._originalSchedule=JSON.parse(JSON.stringify(this.schedule));
          this.offTeukgeun=[{name:this.nurses[2].name,week:2,start:'2026-10-04',end:'2026-10-10'},{name:this.nurses[5].name,week:3,start:'2026-10-11',end:'2026-10-17'}];
          this.showReports=true; this.reportTab='relaxed';
        }else{ this.showReports=false; this.reportTab='summary'; }
      };
      if(screen==='preinput'){
        this.activeTab='preinput'; setSched('none');
        const st=state||'filled';
        setPrev(st!=='empty');
        await this.$nextTick();
        if(st==='menu'){ await new Promise(r=>setTimeout(r,120)); const b=document.querySelector('[data-rd=btn-import]'); if(b) b.click(); }
        if(st==='popup'){ const n=this.nurses[0]; const day=new Date(2026,9,7); this.openPrevEdit(n, day); this.focusCell(0, 10); this.rdPlacePopup(); }
        if(st==='paste'){ this.openPastePrev(); }
        if(st==='toast'||st==='filled'){ this.rdToast={msg:'위시 시트 17명 · 42칸을 넣었습니다.', undo:true}; }
      }else if(screen==='schedule'){
        this.activeTab='schedule'; setPrev(true);
        const st=state||'success';
        if(st==='before') setSched('none');
        else if(st==='running'){ setSched('none'); this.generating=true; this.estimatedSeconds=180; this.generateElapsed=30; this.statusMessage='';
          // 상태 줄 아래 계산 기록 — 진행 한 줄 + 기록 몇 줄이 있어야 검사기가 이 자리를 본다
          this.showLiveLog=true; this.solveProgress={gap_percent:3.4, nodes:1520, has_solution:true, is_running:true, stalled_seconds:12};
          this.solverLogs=['Running HiGHS 1.8.1: Copyright (c) 2024 HiGHS under MIT licence terms','Presolving model','Solving MIP model with:','   9445 rows','   5272 columns (5180 binary, 0 integer)',
            ' H       0       0         0   0.00%   -37065          -35120             5.25%        0      0      0         0     1.7s',
            '         1       0         1 100.00%   -36980          -35730             3.40%      812     95    410      1520     9.4s'].map((msg,i)=>({id:i+1, msg})); }
        else if(st==='failed'){
          setSched('none'); this.statusOk=false;
          this.statusMessage='★ 10/03(토) D 인원 부족: 필요 4명, 가용 3명\n사전입력을 확인하세요.';
          this.staffingAlerts={short:[{dk:'2026-10-03',needed:12,avail:11}],tight:[]};
          this.prevSchedule[this.nurses[0].id]['2026-10-03']='V'; this.prevSchedule[this.nurses[3].id]['2026-10-03']='주';
          this.diagResult={anchored:[{label:'김지현 10/3 V',nurse_id:this.nurses[0].id,date:'2026-10-03'},{label:'정수아 10/3 주',nurse_id:this.nurses[3].id,date:'2026-10-03'}]};
        }
        else if(st==='relaxed') setSched('relaxed');
        else setSched('success');
        if(st==='print'){ this.showPrintPreview=true; }
        const dark=(st==='dark'); if(this.darkMode!==dark){ this.darkMode=dark; document.documentElement.classList.toggle('dark', dark); }
      }else if(screen==='settings'){
        this.activeTab='settings'; setSched('none'); setPrev(true); this.settingsSection='roster';
        if(state==='modal'){ this.openNurseModal(this.nurses[0]); this.rdSpecialOpen=false; }
      }else if(screen==='phone'){
        this.activeTab='today'; setPrev(true); setSched('success');
        const k=this.todayKey(); this.nurses.forEach((n,i)=>{ (this.schedule[n.id]=this.schedule[n.id]||{})[k]=['E','D','N','OF','D','E'][i%6]; });
        this.setMyNurse(this.nurses[0].id);
      }
      if(screen!=='schedule' && this.darkMode){ this.darkMode=false; document.documentElement.classList.remove('dark'); }
      await this.$nextTick(); await new Promise(r=>setTimeout(r, 300));
      return true;
    },
    _rdFixtures(){
      const nurses=this.nurses; const days=this.scheduleDays; const dk=d=>this.dayKey(d);
      const hol=new Set(this.holidays);
      const prev={}, locks={}, notes={};
      nurses.forEach((n,i)=>{ const row={};
        for(let w=0;w<5;w++){ const idx=w*7+((i*3)%7); if(idx<days.length) row[dk(days[idx])]='주'; }
        if(i%4===1) row[dk(days[8+i%5])]='V';
        if(i%5===2) row[dk(days[16+i%4])]='생';
        if(i%6===3){ row[dk(days[22])]='N'; row[dk(days[23])]='N'; }
        if(i===0){ row[dk(days[10])]='V'; row[dk(days[11])]='V'; }
        if(i===2) row[dk(days[13])]='특';
        if(i===7) row[dk(days[19])]='공';
        days.forEach(d=>{ const k=dk(d); if(hol.has(k)&&!row[k]) row[k]='법'; });
        prev[n.id]=row; });
      if(nurses[0]) locks[nurses[0].id]={[dk(days[10])]:true,[dk(days[11])]:true};
      if(nurses[7]) locks[nurses[7].id]={[dk(days[19])]:true};
      if(nurses[2]) notes[nurses[2].id]={[dk(days[13])]:'가족 여행'};
      const base=['주','N','OF','D','E','N','D','E','N','OF','D','E','N','D','E','N','OF','D','E','N','D','E','N','OF','D','E','N','D','E','N','OF','D'];
      const sched={};
      nurses.forEach((n,i)=>{ const row={};
        days.forEach((d,k)=>{ let code = k<3 ? base[(30+k-i+32)%32] : base[((k-3-i)%32+32)%32]; const key=dk(d);
          if(hol.has(key)&&k>=3&&i%3===0) code='법';
          if(i===0&&(k===13||k===14)) code='V';
          row[key]=code; });
        sched[n.id]=row; });
      const at=(i,k)=>[nurses[i]?nurses[i].id:null, dk(days[k])];
      const edited=[at(0,20),at(3,21)].filter(x=>x[0]);
      const schedLocks={}; for(const [nid,k] of [at(0,13),at(0,14),at(7,22)]){ if(nid) (schedLocks[nid]=schedLocks[nid]||{})[k]=true; }
      const relax=[[1,15,'주','D'],[4,9,'OF','E'],[10,22,'V','N']].filter(r=>nurses[r[0]]).map(([i,k,from,to])=>({nid:nurses[i].id, dk:dk(days[k]), from, to}));
      return {prev, locks, notes, sched, edited, schedLocks, relax};
    },
  };
};
