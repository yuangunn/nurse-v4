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
  // HiGHS 기록의 Src 글자 — 그 해를 어떻게 찾았는가 (기록 머리줄의 범례 그대로)
  const SRC = {B:'Branching', C:'Central rounding', F:'Feasibility pump', H:'Heuristic', L:'Sub-MIP', P:'Empty MIP', R:'Randomized rounding', S:'Solve LP', T:'Evaluate node', U:'Unbounded',
    z:'Trivial zero', l:'Trivial lower', u:'Trivial upper', p:'Trivial point'};
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const fmtMD = dk => `${+dk.slice(5,7)}/${+dk.slice(8,10)}`;
  const fmtKo = dk => { const d = new Date(dk + 'T00:00:00'); return `${d.getMonth()+1}월 ${d.getDate()}일(${WD[d.getDay()]})`; };
  return {
    // ── 상태 ──
    drawerBig: false,            // 서랍을 화면 가운데 큰 창으로 (크게 보기)
    reportTab: 'summary',        // 서랍 탭: summary·relaxed·v·teukgeun·warn·wish·log
    showLiveLog: false,          // 만드는 중 원본 계산 기록 — 기본은 접고 해석한 계산 현황(rdSolveCards·solveStats.events)을 보인다
    solveStats: null,            // 솔버 기록에서 읽은 것 {phases:[{n,rows0,cols0,rows,cols,restarts,status,row}], events:[…]} (_solveFeed)
    story: {open:false, step:0}, // 결과 요약 — 생성이 끝나면 단계별로 넘겨 보는 창 (rdStorySteps)
    storyHint: false,            // 요약을 중간에 닫은 직후 — 상태 줄 '결과 요약 다시 보기'를 잠깐 강조
    rdWhy: false,                // 원티드 미반영 탭에서 칸마다 그날 사정을 펼쳐 보인다 ('칸별 이유가 궁금하다면?')
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
          return {kind:'warn', running:true, text:`지금 표는 저장했어요${g!=null?` (가장 좋은 답과 ${Math.round(g*10)/10}% 차이)`:''} · 그 표에서 더 좋은 표를 찾는 중… ${t} · 멈추면 지금 표를 씁니다`};
        }
        return {kind:'warn', running:true, text:`근무표를 만드는 중… ${t}`};
      }
      if(!this.rdSched) return null;
      if(this.rdPreChanged) return {kind:'warn', changed:true, text:'사전입력을 고친 뒤 아직 다시 만들지 않았어요 — 지금 표는 고치기 전 사전입력으로 만든 것입니다'};
      const rx=this.rdRelaxedCount;
      const pre=this.countPrevEntries();
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
      if(tc) return {kind:'ok', text:`근무표가 ${saved}${at} · 사전입력 ${Math.max(pre-tc,0)}칸 지켰어요${tcNote}${q}`};
      return {kind:'ok', text:`근무표가 ${saved}${at} · 사전입력 ${pre}칸 모두 지켰어요${q}`};
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

    // ── 계산 현황 — 솔버(HiGHS) 기록을 줄 단위로 읽어 숫자와 사건으로 (결정 1-64) ──
    // 화면에 남기는 기록(solverLogs)은 최근 200줄로 잘리므로, 줄이 들어올 때마다 여기에 쌓는다. 한 번의 생성에 풀이(Presolving model)가
    // 여러 번 올 수 있다(완화 단계). CP-SAT 기록은 형식이 달라 읽지 않는다 — 카드는 진행 정보(solveProgress)의 노드·Gap 만 보인다.
    _solveReset(){ this.solveStats={phases:[], events:[], seq:0}; },
    _pushLog(msg, hint){
      this.solverLogs.push(hint ? {id:++this._logSeq, msg, hint:true} : {id:++this._logSeq, msg});
      if(!hint){ if(this.solverLogs.length>300) this.solverLogs=this.solverLogs.slice(-200); for(const l of String(msg).split('\n')) this._solveFeed(l); }   // 한 메시지에 여러 줄이 온다
      this._scrollLogs();
    },
    _solveFeed(line){
      if(!this.solveStats) this._solveReset();
      const S=this.solveStats, n=x=>Number(x).toLocaleString('ko-KR'); let P=S.phases[S.phases.length-1], m;
      const ev=text=>{ const r=(P&&P.row)||{}; S.events.push({id:++S.seq, solve:S.phases.length, time:r.time??0, text, nodes:r.proc??0, sol:r.sol??'', gap:r.gap??''}); if(S.events.length>200) S.events.splice(0, S.events.length-200); };
      line=String(line??'');
      if(/^Presolving model/.test(line)){ S.phases.push({n:S.phases.length+1, rows0:null, cols0:null, rows:null, cols:null, restarts:0, status:'', row:null, start:null, had:false}); return; }
      if(!P) return;
      if((m=line.match(/^(\d+) rows, (\d+) cols, \d+ nonzeros/))){ if(P.rows0==null){ P.rows0=+m[1]; P.cols0=+m[2]; } P.rows=+m[1]; P.cols=+m[2]; return; }
      if((m=line.match(/^MIP start solution is feasible, objective value is (\S+)/))){ P.start=m[1]; P.had=true; ev(`MIP start — 앞에서 찾은 해로 시작 (objective ${m[1]})`); return; }
      if(/^Solving MIP model with/.test(line)){ if(P.rows0!=null) ev(`Presolve — ${n(P.rows0)} → ${n(P.rows)} rows · ${n(P.cols0)} → ${n(P.cols)} cols`); return; }
      if((m=line.match(/^([\d.]+)% inactive integer columns, restarting/))){ P.restarts++; P.inactive=m[1]; return; }
      if((m=line.match(/^Model after restart has (\d+) rows, (\d+) cols/))){ ev(`Restart — inactive integer columns ${P.inactive}% → ${n(m[1])} rows · ${n(m[2])} cols`); return; }
      if((m=line.match(/^\s*([A-Za-z])?\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)%\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)s\s*$/))){
        const row={src:m[1]||(P.row&&P.row.src)||'', proc:+m[2], queue:+m[3], leaves:+m[4], expl:+m[5], bound:m[6], sol:m[7], gap:m[8], cuts:+m[9], inlp:+m[10], confl:+m[11], lpit:+m[12], time:+m[13]};
        const better=row.sol!=='inf' && row.sol!==(P.row ? P.row.sol : P.start);
        P.row=row;
        if(better){ ev(`${P.had?'더 좋은 해':'첫 해'} 발견${m[1]?` — Src ${m[1]} (${SRC[m[1]]||m[1]})`:''}`); P.had=true; }
        return;
      }
      if((m=line.match(/^\s+Status\s+(.+)$/))){ P.status=m[1].trim(); ev(`Solving report — ${P.status}`); }
    },
    // 숫자 카드 — 지금 풀이의 마지막 줄. 용어는 솔버 기록 그대로, 뜻은 툴팁
    get rdSolveCards(){
      const S=this.solveStats, P=S&&[...S.phases].reverse().find(p=>p.row), n=x=>Number(x).toLocaleString('ko-KR');
      if(!P){
        const p=this.solveProgress||{}; if(!(p.nodes>0) && p.gap_percent==null) return [];
        return [{k:'노드', v:n(p.nodes||0), tip:'지금까지 처리한 탐색 노드 수'}, {k:'Gap', v:p.gap_percent==null?'—':(Math.round(p.gap_percent*100)/100)+'%', tip:'가장 좋은 해와 이론상 한계의 차이'}];
      }
      const r=P.row;
      return [
        {k:'노드 (Proc.)', v:n(r.proc), tip:'분기 한정(B&B)에서 처리를 끝낸 노드 수 — 지금까지 따져 본 경우'},
        {k:'대기 (InQueue)', v:n(r.queue), tip:'아직 열려 있어 더 따져 봐야 하는 노드 수'},
        {k:'리프 (Leaves)', v:n(r.leaves), tip:'가지치기·불가능·해 발견으로 닫힌 끝 노드 수 — 더 볼 필요가 없어 쳐낸 경우'},
        {k:'탐색 (Expl.)', v:r.expl+'%', tip:'탐색 트리에서 살펴본 비율'},
        {k:'BestSol', v:r.sol==='inf'?'—':r.sol, tip:'지금까지 찾은 가장 좋은 해의 목적함수 값 (낮을수록 좋다)'},
        {k:'BestBound', v:r.bound, tip:'이론상 이보다 좋을 수 없는 한계 값'},
        {k:'Gap', v:r.gap==='inf'?'—':r.gap, tip:'BestSol 과 BestBound 의 차이 — 0% 면 가장 좋은 해'},
        {k:'Cuts', v:n(r.cuts), tip:'탐색 범위를 좁히려고 더한 절단 제약 수'},
        {k:'Confl.', v:n(r.confl), tip:'충돌 분석으로 알아낸 제약 수'},
        {k:'LP iters', v:n(r.lpit), tip:'LP 완화를 푼 단체법 반복 수'},
        {k:'방법 (Src)', v:r.src ? `${r.src} · ${SRC[r.src]||''}` : '—', tip:'가장 최근 해를 찾은 방법 — B 분기 · H 휴리스틱 · L Sub-MIP · F Feasibility pump · T 노드 평가 등'},
      ];
    },
    get rdSolveSub(){
      const S=this.solveStats, P=S&&S.phases[S.phases.length-1], n=x=>Number(x).toLocaleString('ko-KR'); if(!P) return '';
      return `Solve #${P.n}` + (P.rows0!=null ? ` · Presolve ${n(P.rows0)} → ${n(P.rows)} rows · ${n(P.cols0)} → ${n(P.cols)} cols` : '') + (P.restarts ? ` · Restart ${P.restarts}회` : '') + (P.status ? ` · ${P.status}` : '');
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
      const sec=Math.round((this.generationReport&&this.generationReport.duration_seconds) || sum('time') || 0);
      const dur=sec>=60 ? `${Math.floor(sec/60)}분 ${sec%60}초` : `${sec}초`;
      const g=this.mipGapPercent;
      const calc=[];
      if(sec) calc.push(['걸린 시간', dur]);
      if(ph.length){
        calc.push(['풀이 횟수 (Solve)', `${ph.length}회`], ['처리한 노드 (Proc.)', n(sum('proc'))], ['닫힌 리프 (Leaves)', n(sum('leaves'))], ['LP iterations', n(sum('lpit'))]);
        if(ph[0].rows0!=null) calc.push(['Presolve', `${n(ph[0].rows0)} → ${n(ph[0].rows)} rows`]);
        if(lastP.row.src) calc.push(['해를 찾은 방법 (Src)', `${lastP.row.src} · ${SRC[lastP.row.src]||''}`]);
        if(lastP.status) calc.push(['Status', lastP.status]);
      }
      if(g!=null) calc.push(['Gap', (Math.round(g*100)/100)+'%']);
      else if(lastP && lastP.row.gap!=='inf') calc.push(['Gap', lastP.row.gap]);
      steps.push({id:'calc', eyebrow:'계산', title: ph.length ? `노드 ${n(sum('proc'))}개를 따져 봤어요` : '근무표를 계산했어요',
        sub: this.scheduleStopped ? '중간에 멈춰 그때까지 찾은 해입니다.' : (g==null ? '' : (g<=0.1 ? 'Gap 0% — 이 조건에서 가장 좋은 해입니다.' : `가장 좋은 해와 ${Math.round(g*10)/10}% 안쪽 차이에서 멈췄습니다.`)), facts:calc});
      const pre=this.countPrevEntries(), rx=this.rdRelaxedCount, tc=this.rdTraineeChanged;
      // 표 아래 '배정 / 필요' 줄과 같은 셈 — 날짜별로 고친 필요 인원(rdFootNeed)과 견준다
      const rowsDEN=(this.footerRows||[]).filter(r=>['D','E','N'].includes(r.label));
      const short=this.scheduleDays.filter(d=>!this.isOverflow(d)).reduce((a,d)=>a+rowsDEN.filter(r=>this.getDayDutyCount(d,r.shifts)<(+this.rdFootNeed(d,r.label)||0)).length, 0);
      const kept=[['사전입력', `${n(pre)}칸`], ['그대로 지킨 칸', `${n(Math.max(pre-rx-tc,0))}칸`]];
      if(tc) kept.push(['신규 트레이닝 날 (프리셉터 근무를 따름)', `${tc}칸`]);
      kept.push(['날마다 필요 인원 (D·E·N)', short ? `${short}곳 모자람` : '모두 채움']);
      steps.push({id:'kept', eyebrow:'지킨 것', title: rx ? `사전입력 ${n(pre)}칸 중 ${n(Math.max(pre-rx-tc,0))}칸을 지켰어요` : `사전입력 ${n(pre)}칸을 모두 지켰어요`, sub:'', facts:kept});
      if(rx) steps.push({id:'changed', eyebrow:'바꾼 것', title:`${rx}칸은 바꿀 수밖에 없었어요`, sub:'바꾸면 안 되는 칸은 되돌려서 잠금을 누른 뒤 다시 만들어 보세요.', facts:[]});
      const chk=(this.scheduleWarnings||[]).filter(w=>w.type==='check').length, ot=(this.offTeukgeun||[]).length, v=(this.vReport&&this.vReport.total)||0;
      const wr=this.wishReport, unmet=wr ? Math.max(0,(wr.total_requested||0)-(wr.total_granted||0)) : 0;
      const check=[];
      if(chk) check.push(['파트장 확인 필요 (연속 근무 한도+1 · E→D1 · 중→D)', `${chk}건`, 'warn']);
      if(ot) check.push(['오프특근 (주 1회 OFF 반납)', `${ot}건`, 'teukgeun']);
      if(v) check.push(['자동으로 넣은 연차 (V)', `${v}건`, 'v']);
      if(unmet) check.push(['못 들어간 희망 근무', `${unmet}건`, 'wish']);
      if(check.length) steps.push({id:'check', eyebrow:'확인할 것', title:`확인할 것이 ${check.length}가지 있어요`, sub:'줄을 누르면 근무표 아래 리포트의 그 탭이 열립니다.', facts:check});
      steps.push({id:'done', eyebrow:'결과', title:'근무표가 준비됐어요', sub: this.rdSaved ? '자동으로 저장했습니다.' : '', facts:[]});
      return steps;
    },
    // 칸별 이유가 궁금하다면? — 원티드 미반영 목록을 큰 창으로 열고 칸마다 그날 사정을 펼친다
    rdOpenWhy(){ this.story.open=false; this.rdWhy=true; this.rdOpenDrawer('relaxed'); this.drawerBig=true; },
    // 그날 사정 — 그날 근무할 수 있는 사람이 필요 인원보다 모자랐는가 (사전입력 기준 산술, 인원 여유 검사 _checkStaffing 과 같은 셈).
    // 어느 규칙과 부딪혔는지(칸별 이유)는 엔진이 아직 주지 않는다 — 인원이 모자란 날만 '풀 수밖에 없는 날'이라고 말한다
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
        ? `그날 사정 — 근무할 수 있는 사람(${can}명)이 필요 인원(${need}명)과 딱 맞아 여유가 없는 날이었습니다. 야간전담·임산부처럼 그날 설 수 있는 근무가 정해진 사람이 있으면 쉬는 날 원티드를 풀어야 할 수 있습니다. 어느 규칙과 부딪혔는지는 아직 보여 드리지 못합니다.`
        : `그날 사정 — 사람 수만 보면 ${can-need}명 여유가 있었습니다 (필요 ${need}명 · 근무할 수 있는 사람 ${can}명). 연속 근무·야간 뒤 휴무·주 1회 OF 같은 다른 규칙과 부딪혔을 수 있는데, 어느 규칙인지는 아직 보여 드리지 못합니다.`};
    },

    // ── 실패 배너 ──
    // 보고 있는 달의 저장본 중 가장 새것 (목록은 새것부터) — 앱을 다시 열면 표는 비어 있고 저장본만 남는다
    get rdSavedThisMonth(){ return (this.savedSchedules||[]).find(sv=>sv.year===this.year&&sv.month===this.month)||null; },
    get rdFail(){
      if(this.generating || this.statusOk || !this.statusMessage || this.rdSched) return null;
      const short=((this.staffingAlerts||{}).short)||[];
      const anchored=[...(((this.diagResult||{}).anchored)||[]), ...(((this.feas||{}).anchored)||[])].filter(a=>a&&(a.nurse_id||a.date));
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
        body=`그날 나올 수 있는 사람은 ${a.avail}명인데 필요 인원은 ${a.needed}명입니다. 아래 셋 중 하나를 바꾸면 풀립니다.`;
        if(fixes.length<3){
          const req={...(this.requirements?.[['sun','mon','tue','wed','thu','fri','sat'][new Date(a.dk+'T00:00:00').getDay()]]||{}), ...(this.prevDayReqs?.[a.dk]||{})};
          const p=['D','E','N'].sort((x,y)=>(+req[y]||0)-(+req[x]||0))[0];
          const need=+req[p]||0;
          if(need>1) fixes.push({kind:'req', label:`${fmtMD(a.dk)} ${PERIOD_KO[p]} 필요 인원 ${need} → ${need-1}`, dk:a.dk, period:p});
        }
      }else{
        // 생성 결과·신호등의 한 줄 요약이 있으면 그것을 쓴다 — 진단 첫 줄('원인 진단 결과:')은 아무것도 말하지 않는다
        const summary=((this.diagResult||{}).summary)||((this.feas||{}).status==='infeasible' ? (this.feas||{}).summary : '');
        const first=(this.statusMessage||'').split('\n').map(s=>s.replace(/^[★⚠❌✗\s]+/,'').trim()).find(s=>s&&!/^[━─=]+/.test(s)&&!/원인 진단 결과:?$/.test(s))||'';
        title=summary ? `이 조건으로는 만들 수 없어요. ${summary}` : `이 조건으로는 만들 수 없어요.${first ? ' '+first.slice(0,80) : ''}`;
        body='아래에서 하나를 고치거나 사전입력 완화를 켜고 다시 만들어 보세요. 잠근 칸은 완화해도 바뀌지 않습니다.';
      }
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
    rdRemake(){ this.activeTab='schedule'; if(!this.generating) this.generate(); },

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
    get rdMakeLabel(){ return this.generating ? '만드는 중…' : (this.rdSched ? '다시 만들기' : '근무표 만들기'); },
    get rdMakeTip(){ return this.rdSched ? (this.rdPreChanged?'고친 사전입력으로 새로 만듭니다. ':'')+'지금 표를 버리고 새로 만듭니다. 저장한 표는 불러오기에 남아 있어요.' : `사전입력을 지키면서 자동으로 채웁니다. ${this.feas&&this.feas.estimated_seconds ? this.rdEta(this.feas.estimated_seconds)+' 걸리고' : '몇 분 걸리고'} 중간에 멈출 수 있어요.`; },

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
    // 원티드 색을 칠할 칸 — 사전입력 값이 있는 칸. 주휴(주)·달 밖 날짜, 그리고 지난달과 겹친 첫 주기(지난달 근무표에서 이어온 칸)는 뺀다
    isWanted(nid, day){
      const c=this.getPrevShift(nid, day); if(!c || c==='주' || this.isOverflow(day)) return false;
      const s=this.scheduleDays[0]; return !(this.isOverflow(s) && Math.round((day-s)/86400000)<7);
    },
    rdIsPre(nid, day){ return !!this.getPrevShift(nid, day) && !this.isRelaxed(nid, day) && !this.isManuallyEdited(nid, day); },
    // 사전입력 툴바의 다음 단계 단추 — 근무표가 없으면 넘어가서 바로 만들고, 있으면 보여 주기만 한다 (만든 표를 말없이 버리지 않는다)
    rdGoMake(){ this.activeTab='schedule'; if(!this.rdSched && !this.generating) this.generate(); },

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
