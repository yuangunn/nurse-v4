/* ────────────────────────────────────────────────────────────────────────────
 * 스케줄 기능 — 엑셀/인쇄 내보내기·스케줄 비교·수동편집 추적·월간 요약·이전달 연동·희망근무 입력·템플릿·간호사 CSV 입출력
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
      let filled=0, holes=[], flex=[];
      for(const n of this.nurses){
        for(const d of days){
          const c=this.prevSchedule[n.id]?.[this.dayKey(d)];
          if(c&&this.isFlexWish(c)) flex.push(`${n.name} ${d.getMonth()+1}/${d.getDate()} ${c}`);
          else if(c) filled++;
          else holes.push(`${n.name} ${d.getMonth()+1}/${d.getDate()}`);
        }
      }
      // D/E·N제외 같은 원티드는 한 근무가 아니다 — 근무표 칸에 그대로 옮기면 안 된다
      if(flex.length){ this.toast(`원티드 ${flex.length}칸이 한 근무로 정해지지 않았습니다 (예: ${flex.slice(0,2).join(', ')}). 근무표 만들기로 정하세요`,'error',6000); return }
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
      this.contBase=null; this.genRound=1; this.genRounds=[];   // 사람이 확정한 표다 — '이 표에서 더 찾기'가 앞 생성의 사전입력 · 규칙으로 다시 풀어 이 표를 바꾸지 않게 (결정 1-116)
      this.activeTab='schedule';
      this.trackEdits();   // 확정한 표가 새 기준 (고친 칸·근무표 되돌리기)
      this.rdDoneAt=new Date(); this._autoSaveSchedule();   // 확정도 생성과 같이 자동 저장
      this.toast(`근무표로 확정했습니다 (${filled}건) — 점수는 솔버를 돌려야 나옵니다`,'info');
    },

    // 어싸인(standalone)에 붙여넣을 수 있는 표로 복사 — 이름 + 날짜 + 근무
    // 차지(DC/EC/NC)는 그대로 — 배정표가 이것으로 차지를 안다. plainShift/displayShift 를 거치지 말 것.
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
    // 병동 번표 양식 xlsx (서버 _build_schedule_xlsx) — 계는 수식 + 계산해 둔 값이라 '근무표 파일 올리기'로 다시 올릴 수 있다
    async exportToXlsx(){
      if(!this.schedule||!Object.keys(this.schedule).length){ this.toast('근무표가 없습니다','error'); return }
      try{
        const url=URL.createObjectURL(await this._xlsxBlob());
        const a=document.createElement('a');
        a.href=url;a.download=`근무표_${this.year}년${this.month}월.xlsx`;
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);URL.revokeObjectURL(url);
      }catch(e){this.toast(e.message||'내보내기 실패','error')}
    },
    async _xlsxBlob(){
      const res=await fetch('/api/schedules/export.xlsx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...this._xlsxBody(),prev:await this._xlsxPrev()})});
      if(!res.ok){ const d=(await res.json().catch(()=>null))?.detail; throw new Error(typeof d==='string'?d:'내보내기 실패') }
      return res.blob();
    },
    // ── 근무표 그림 (결정 1-85) — 엑셀 번표 양식과 같은 모양을 canvas 에 직접 그린다: 이름 칸 팀 색 · 팀 사이 굵은 선 · 원티드 분홍 ·
    //    풀린 칸 파랑 · 나이트킵 노랑 · 오른쪽 계(그 달 칸만) · 아래 날마다 인원. 엑셀 파일(xlsx)은 브라우저가 공유·복사를 막아(결정 1-81)
    //    메신저에는 그림으로 보낸다. 자료는 엑셀과 같은 _xlsxBody (차지는 D/E/N) ──
    _scheduleCanvas(){
      const b=this._xlsxBody(), rows=b.rows, nd=b.days.length, hol=new Set(b.holidays||[]);
      const days=b.days.map(k=>new Date(k+'T00:00:00')), inMonth=days.map(d=>d.getFullYear()===+b.year&&d.getMonth()===+b.month-1);
      const codes=rows.map(r=>r.slice(1).map(c=>String(c||'').toUpperCase()));
      const has=c=>codes.some(r=>r.includes(c));
      const totals=['D','E','N',...(has('중')?['중']:[]),'OF','법','생','V','주','총근무'], work=['D','E','N','중'];
      const foot=['D','E','N',...(has('중')?['중']:[]),'근무자수'];
      const K=2, PAD=16, TITLE=34, NW=96, CW=30, TW=32, HH=22, RH=24, FONT="'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif";
      const W=PAD*2+NW+CW*nd+TW*totals.length, H=PAD*2+TITLE+HH*2+RH*rows.length+RH*foot.length;
      const cv=document.createElement('canvas'); cv.width=W*K; cv.height=H*K;
      const g=cv.getContext('2d'); g.scale(K,K); g.fillStyle='#FFFFFF'; g.fillRect(0,0,W,H); g.textBaseline='middle';
      const x0=PAD, xc=x0+NW, xt=xc+CW*nd, y0=PAD+TITLE, yr=y0+HH*2, yf=yr+RH*rows.length;
      const box=(x,y,w,h,fill)=>{ if(fill){ g.fillStyle=fill; g.fillRect(x,y,w,h); } g.strokeStyle='#9AA1AC'; g.lineWidth=.5; g.strokeRect(x+.25,y+.25,w-.5,h-.5); };
      const text=(s,x,y,w,h,{color='#111',size=12,bold=true,align='center'}={})=>{ if(s===''||s==null) return; g.fillStyle=color; g.font=`${bold?'700 ':''}${size}px ${FONT}`; g.textAlign=align;
        let str=String(s); while(str.length>1&&g.measureText(str).width>w-4) str=str.slice(0,-1); g.fillText(str, align==='left'?x+6:x+w/2, y+h/2+.5); };
      const dark=hex=>{ const m=/^#?([0-9a-f]{6})$/i.exec(hex||''); if(!m) return false; const n=parseInt(m[1],16); return (((n>>16)&255)*299+((n>>8)&255)*587+(n&255)*114)/1000<140; };
      text(b.title||`${b.year}년 ${b.month}월 근무표`, x0, PAD, W-PAD*2, TITLE, {size:16, align:'left'});
      // 머리줄 — 날짜 · 요일 (일요일·공휴일은 빨강)
      box(x0,y0,NW,HH*2,'#F4F5F7'); text('이름', x0, y0, NW, HH*2);
      days.forEach((d,i)=>{ const red=d.getDay()===0||hol.has(b.days[i]), c=red?'#D0021B':(inMonth[i]?'#111':'#8A93A1');
        box(xc+CW*i,y0,CW,HH,'#F4F5F7'); text(d.getDate()===1||i===0?`${d.getMonth()+1}/${d.getDate()}`:d.getDate(), xc+CW*i, y0, CW, HH, {color:c, size:11});
        box(xc+CW*i,y0+HH,CW,HH,'#F4F5F7'); text('일월화수목금토'[d.getDay()], xc+CW*i, y0+HH, CW, HH, {color:c, size:11}); });
      const TF={N:'#FFFF00','중':'#00B0F0','생':'#A9D08E',V:'#A9D08E'};
      totals.forEach((t,j)=>{ box(xt+TW*j,y0,TW,HH*2,TF[t]||'#F4F5F7'); text(t, xt+TW*j, y0, TW, HH*2, {size:t==='총근무'?9:11}); });
      // 줄 — 이름(팀 색) · 근무(표식 색) · 계(그 달 칸만)
      const MARK={w:'#FF99FF', k:'#FFFF00', r:'#0070C0'};
      rows.forEach((r,k)=>{ const y=yr+RH*k, tc=(b.team_colors||{})[(b.teams||[])[k]]||'';
        box(x0,y,NW,RH,tc||'#FFFFFF'); text(r[0], x0, y, NW, RH, {color:tc&&dark(tc)?'#FFFFFF':'#111', align:'left'});
        for(let i=0;i<nd;i++){ const mk=(b.marks?.[k]||'')[i]; box(xc+CW*i,y,CW,RH,MARK[mk]||'#FFFFFF'); text(r[i+1]||'', xc+CW*i, y, CW, RH, {color:mk==='r'?'#FFFFFF':'#111', size:11}); }
        const cnt=t=>codes[k].reduce((a,c,i)=>a+(inMonth[i]&&c===t?1:0),0);
        totals.forEach((t,j)=>{ const v=t==='총근무'?work.reduce((a,c)=>a+cnt(c),0):cnt(t); box(xt+TW*j,y,TW,RH,TF[t]||'#FFFFFF'); text(v||'', xt+TW*j, y, TW, RH, {size:11, bold:false}); }); });
      // 아래 — 날마다 인원
      foot.forEach((t,j)=>{ const y=yf+RH*j; box(x0,y,NW,RH,t==='N'?'#FFFF00':'#F4F5F7'); text(t, x0, y, NW, RH, {size:11});
        for(let i=0;i<nd;i++){ const v=codes.reduce((a,r)=>a+((t==='근무자수'?work.includes(r[i]):r[i]===t)?1:0),0); box(xc+CW*i,y,CW,RH,t==='N'?'#FFFF00':'#FFFFFF'); text(v||'', xc+CW*i, y, CW, RH, {size:11, bold:false}); } });
      // 굵은 선 — 바깥 · 머리줄 아래 · 팀이 바뀌는 줄 위 · 일요일 앞 · 계 앞
      g.strokeStyle='#111'; g.lineWidth=1.5; const line=(x1,y1,x2,y2)=>{ g.beginPath(); g.moveTo(x1,y1); g.lineTo(x2,y2); g.stroke(); };
      g.strokeRect(x0,y0,W-PAD*2,H-PAD-y0); line(x0,yr,W-PAD,yr); line(x0,yf,W-PAD,yf); line(xc,y0,xc,H-PAD); line(xt,y0,xt,yf);
      rows.forEach((r,k)=>{ if(k&&(b.teams||[])[k]!==(b.teams||[])[k-1]) line(x0,yr+RH*k,W-PAD,yr+RH*k); });
      days.forEach((d,i)=>{ if(i&&d.getDay()===0) line(xc+CW*i,y0,xc+CW*i,H-PAD); });
      return cv;
    },
    _scheduleImageBlob(){ return new Promise((res,rej)=>this._scheduleCanvas().toBlob(b=>b?res(b):rej(new Error('그림을 만들지 못했습니다')),'image/png')); },
    get rdCanCopyImage(){ try{ return typeof ClipboardItem!=='undefined'&&!!navigator.clipboard&&!!navigator.clipboard.write }catch(e){ return false } },
    get rdCanShareImage(){ try{ return !!navigator.canShare&&navigator.canShare({files:[new File([''],'a.png',{type:'image/png'})]}) }catch(e){ return false } },
    // 그림으로 복사 — 채팅창(카카오톡·팀즈 등)에 붙여 넣는다. 클릭의 효력이 남아 있는 동안 써야 해서 그림은 약속(Promise)째 넘긴다
    async copyScheduleImage(){
      if(!this.schedule||!Object.keys(this.schedule).length){ this.toast('근무표가 없습니다','error'); return }
      try{ await navigator.clipboard.write([new ClipboardItem({'image/png':this._scheduleImageBlob()})]);
        this.toast('근무표 그림을 복사했습니다 — 채팅창에서 붙여넣기(Ctrl+V)하세요','success',5000);
      }catch(e){ this.toast('그림을 복사하지 못했습니다 — 그림 파일로 저장해 보내 주세요','error') }
    },
    async shareScheduleImage(){
      if(!this.schedule||!Object.keys(this.schedule).length){ this.toast('근무표가 없습니다','error'); return }
      try{ const name=`근무표_${this.year}년${this.month}월.png`;
        await navigator.share({files:[new File([await this._scheduleImageBlob()],name,{type:'image/png'})],title:name});
      }catch(e){ if(e&&e.name==='AbortError')return; this.toast('공유 창을 열지 못했습니다 — 그림으로 복사해 붙여 넣어 주세요','error') }
    },
    async saveScheduleImage(){
      if(!this.schedule||!Object.keys(this.schedule).length){ this.toast('근무표가 없습니다','error'); return }
      const url=URL.createObjectURL(await this._scheduleImageBlob()), a=document.createElement('a');
      a.href=url; a.download=`근무표_${this.year}년${this.month}월.png`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    },
    // 날짜 = 화면(사전입력 · 근무표)과 똑같다 (결정 1-114) — 앞에 붙은 지난달 며칠부터 끝에 붙은 다음 달 며칠까지 (12월 = 11/29~1/2).
    // 1일이 일요일인 달은 화면처럼 지난달 마지막 한 주도 함께 나간다 (11월 = 10/25~12/5). 계는 1일~말일 칸만 센다(서버).
    // 앞에 붙은 지난달 며칠은 지난달 근무 그대로라 원티드 색을 칠하지 않는다. 앞 달 표에도 있는 날짜는 그 시트를 가리킨다 (_xlsxPrev).
    // 칸은 인쇄와 같다 — 차지 없이 D/E/N (rdPrintCode), 전입 전·전출 뒤는 빈칸.
    // marks = 줄마다 날짜 수만큼 한 글자, 화면 표식과 같은 기준: r 사전입력이 풀린 칸 · w 원티드(분홍) · k 나이트킵 줄(노랑).
    // charge = 그 사람이 차지를 설 수 있는 근무(D·E·N) — 아래 차지 줄 수식이 이 줄들에서 센다.
    _xlsxBody(){
      const first=new Date(this.year,this.month-1,1);
      const days=this.scheduleDays,ns=this.nurses,notes=[];
      ns.forEach((n,k)=>days.forEach((d,i)=>{const t=this.getNote(n.id,d);if(t)notes.push([k,i,t])}));
      return{year:this.year,month:this.month,title:`${this.year}년 ${this.month}월 ${this.rdWard} 근무표`,
        days:days.map(d=>this.dayKey(d)),holidays:this.holidays||[],
        rows:ns.map(n=>[n.name,...days.map(d=>this.isNurseInactive(n,d)?'':this.rdPrintCode(n,d))]),
        teams:ns.map(n=>n.group||''),team_colors:this.teamColorMap,
        marks:ns.map(n=>days.map(d=>this.isNurseInactive(n,d)?' ':this.isRelaxed(n.id,d)?'r'
          :d>=first&&this.rdIsPre(n.id,d)&&this.isWanted(n.id,d)?'w':this.isKeeperDay(n,d)?'k':' ').join('')),
        charge:ns.map(n=>['D','E','N'].filter(s=>(n.capable_shifts||[]).includes(s+'C')).join('')),
        notes};
    },
    // 앞 달 시트 본문 — 이 달 시트의 앞쪽 며칠(지난달 날짜와 1일~첫 토요일)은 앞 달 표에도 있다. 앞 달 저장본이 있으면 그 표를 앞 시트로 같이 내고,
    // 이 달 시트의 그 칸은 앞 달 시트를 가리킨다 (서버, 결정 1-61). 저장본을 열었을 때처럼(loadSaved) 근무표·풀린 칸은 저장본,
    // 명부·사전입력·메모는 지금 것. 앞 달 저장본이 없으면 null — 이 달 시트에 화면 값이 그대로 들어간다.
    // ponytail: 화면 함수들을 그대로 쓰려고 년월·근무표만 바꾼 this 의 사본(Object.create)으로 _xlsxBody 를 부른다
    async _xlsxPrev(){
      const pd=new Date(this.year,this.month-2,1),y=pd.getFullYear(),m=pd.getMonth()+1,v=x=>({value:x});
      const sv=(this.savedSchedules||[]).find(s=>s.year===y&&s.month===m);
      if(!sv)return null;
      const d=(await this.api('GET',`/api/schedules/${sv.id}`)).data||{};
      return this._xlsxBody.call(Object.create(this,{year:v(y),month:v(m),schedule:v(d.schedule||{}),extendedSchedule:v({}),
        relaxedCells:v(d.relaxed_cells||{}),_originalSchedule:v(null)}));
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
      this._preAtMake=this._preKey();   // 이 표가 선 때의 사전입력 — 뒤에 고치면 '다시 만들기'를 알린다 (rdPreChanged)
      this._schedUndo=[];this._schedRedo=[];   // 새 표 — 앞 표로 되돌리지 않는다
      this.checkScheduleViolations();
    },
    // 화면에 보이는 날짜의 사전입력 칸을 한 줄로 — 표를 만든 뒤 사전입력이 바뀌었는지 견준다.
    // ponytail: 사전입력 칸만 본다 — 필요 인원·공휴일·명부를 고친 것은 알리지 않는다. 필요해지면 여기에 더한다
    _preAtMake:null,
    _preKey(ps){
      ps=ps||this.prevSchedule||{};const ks=(this.scheduleDays||[]).map(d=>this.dayKey(d));
      return (this.nurses||[]).map(n=>ks.map(k=>ps[n.id]?.[k]||'').join(',')).join('|');
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
    // 근무표에서 일별 D/E/N 인원 역산 — 재조정 시 이 표의 인원수가 기준 (설정 기본값 무시).
    // 칸이 다 찬 날만 — 빈 꼬리 며칠(완성된 표 확정 경로)을 세면 그 적은 수가 그날 인원으로 걸린다 (결정 1-47)
    _reqFromSchedule(sched){
      const P={DC:'D',D:'D',EC:'E',E:'E',NC:'N',N:'N'};
      const out={};
      for(const days of Object.values(sched||{}))
        for(const[dk,code]of Object.entries(days||{})){
          const p=P[code]; if(!p)continue;
          (out[dk]=out[dk]||{D:0,E:0,N:0})[p]++;
        }
      const rows=Object.keys(sched||{}).map(id=>this.nurses?.find(n=>n.id===id)||{id});
      for(const dk of Object.keys(out))if(!this._dayColumnFull(sched,dk,rows))delete out[dk];
      return out;
    },
    // 그 날 칸이 다 찼나 — 그 날 재적하는 사람(rows) 모두 코드가 있다. 트레이닝 중인 신규 칸은 없어도 된다
    // (프리셉터를 따르는 칸 — 엔진·rdCells 도 세지 않는다)
    _dayColumnFull(sched,dk,rows){
      const[y,m,d]=dk.split('-').map(Number);const day=new Date(y,m-1,d);
      return (rows||[]).every(n=>this.isNurseInactive(n,day)||(n.is_trainee&&this.isTraineeInTraining(n,day))||!!sched?.[n.id]?.[dk]);
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
        for(let[dk,v]of Object.entries(days||{})){
          if(!v||v==='__CLEAR__')continue;
          // 신규의 '/' 칸은 엔진이 프리셉터를 따라 다시 채운다 — 고친 칸이 아니면 사전입력에 넣은 '/' 원티드(넣은 값)만 보낸다
          // (엔진은 '/' 칸을 신규가 넣은 원티드로 읽는다 — 생성이 낸 '/EC' 를 보내면 프리셉터를 고쳐도 따라가지 않는다)
          if(v.startsWith('/')&&!pins[nid]?.[dk]){
            const o=this.prevSchedule?.[nid]?.[dk];
            if(typeof o!=='string'||!o.startsWith('/'))continue;
            v=o;
          }
          (prevPayload[nid]=prevPayload[nid]||{})[dk]=v;
          if(pins[nid]?.[dk])(locked[nid]=locked[nid]||{})[dk]=true;
        }
      }
      const before=JSON.parse(JSON.stringify(this.schedule));
      const here=await this.generate({
        prev_schedule:prevPayload,
        locked_cells:locked,
        per_day_requirements:dayReq,
        time_limit:Math.min(this.generateTimeout*60,300),
        // 수정으로 그날 인원이 어긋난 사전입력은 완화로만 풀린다 —
        // 잠근 칸(locked)은 완화 모드에서도 고정이므로 사용자 수정은 안전
        allow_pre_relax:true,
        _readjust:true,
      });
      if(!here||!this.statusOk)return;   // 실패 시 수정본 유지 + 기존 진단 표시 (그동안 달이 바뀌었으면 화면에 넣지 않았다)
      // 엔진이 맞추는 표를 찾지 못하면 보낸 표를 그대로 확정해 돌려준다(빈칸 없는 표의 길) — 그것은 다시 맞춘 것이 아니다.
      // 예전엔 '재조정 완료 — 따라 고침 0칸'으로 보여, 눌러도 아무 일이 없는 것처럼 보였다 (결정 1-118)
      if(this.pinnedConfirmed){
        this.readjustSummary='';
        this.statusOk=false;
        this.statusMessage='⚠ 다시 맞추지 못했습니다 — 고친 칸을 그대로 두고는 인원·규칙이 맞는 표를 찾지 못해, 표는 고친 그대로입니다.\n'
          +'고친 칸 때문에 그날 인원이 맞지 않거나 연속 근무·야간 뒤 휴무 같은 규칙과 부딪힐 수 있습니다. 칸을 다르게 고치거나, 사전입력 화면의 신호등과 ‘왜 안 되는지 자세히 보기’로 막힌 곳을 확인해 보세요.';
        this.toast('다시 맞추지 못했습니다 — 표는 고친 그대로입니다','error',7000);
        return;
      }
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
      // 이 달 표에 보이는 날만 이월 — 1일 앞 지난달 칸(11월이면 10/25~10/31, 기록)과
      // 지난달 표 끝에 붙어 이미 정해진 이 달 초 며칠(9월 표의 10/1~10/3) 둘 다.
      // 예전엔 뒤쪽만 옮겨 앞 칸이 늘 비었고, 말일이 토요일인 달(10월) 다음엔 '이월할 데이터가 없습니다'였다.
      let count=0;
      const keys=this._cycleDateKeys();
      this._pushUndo();
      for(const[nid,days]of Object.entries(schedule)){
        for(const[dk,shift]of Object.entries(days)){
          if(!keys.has(dk))continue;
          if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
          this.prevSchedule[nid][dk]=shift;count++;
        }
      }
      this._checkViolations&&this._checkViolations();   // 이어온 칸으로 신호등·인원 경고를 다시
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
      this.nurses=t.nurses;this.requirements=t.requirements;this.rules={...this.rules,...this._presetRules(t.rules)};this.rulesFix();   // 옛 템플릿에 없는 새 규칙 키 · 이 병동의 그룹 · 색 · 휴일은 지금 것 그대로
      this.contBase=null;   // 명부가 바뀌었다 — 앞 생성의 요청으로 '더 찾기'를 하지 않는다
      if(t.shifts)this.shifts=t.shifts;
    },
    deleteTemplate(idx){this.templates.splice(idx,1);localStorage.setItem('ns_templates',JSON.stringify(this.templates))},

    // ═══ 간호사 명부 템플릿 다운로드/업로드 (xlsx 기본, CSV도 가져오기 허용) ═══
    // survey: 다른 병동에 보내 채워 받는 명부 조사 양식(결정 1-80) — 한글 칸·예/아니오 고르기. 채워 온 파일은 같은 '가져오기'가 읽는다
    async downloadNurseTemplate(survey){
      try{
        // 드롭다운·안내 시트가 든 엑셀 템플릿 — "CSV로 저장" 단계가 필요 없다
        const res=await fetch(survey?'/api/nurses/survey.xlsx':'/api/nurses/template.xlsx');
        if(!res.ok)throw new Error('템플릿 다운로드 실패');
        const blob=await res.blob();
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');
        a.href=url;a.download=survey?'명부_조사_양식.xlsx':'nurses_template.xlsx';
        document.body.appendChild(a);a.click();
        document.body.removeChild(a);URL.revokeObjectURL(url);
        this.toast(survey?'명부 조사 양식을 내려받았습니다 — 병동에 보내 채워 받은 뒤 엑셀/CSV 가져오기로 올리세요':'엑셀 템플릿 다운로드 완료 — 채워서 그대로 가져오기 하세요','info',5000);
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
