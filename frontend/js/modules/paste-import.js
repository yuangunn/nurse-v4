/* ────────────────────────────────────────────────────────────────────────────
 * 엑셀 사전입력 붙여넣기 — 클립보드/파일 표 파싱·그리드 매칭·적용
 *
 * 대상 3종: 'prev'=사전입력(확정) | 'wish'=희망근무(소프트 ★) | 'saved'=저장탭 근무표 업로드
 * 날짜 해석은 월 인식(5/26, 5월 26일, 2026-05-26) + 일자만 있는 시퀀스의 감소 지점을
 * 월 경계로 보는 멀티월 해석 — 당월 주기 밖 날짜에도 그대로 적용된다.
 *
 * 사용: app() 반환 객체에 `...PasteImportModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.PasteImportModule = function() {
  return {
    // ── 엑셀 사전입력 붙여넣기 ─────────────────────────────────
    pastePrev:{
      open:false,
      rawText:'',
      grid:[],          // 2D array of pasted cells (string)
      mode:'auto',      // 'auto' | 'name-date' | 'cursor'
      target:'prev',    // 'prev'=사전입력(확정) | 'wish'=희망근무(소프트 ★) | 'saved'=저장탭 업로드
      hasNameCol:true,
      hasDateRow:true,
      matches:null,     // {nameRow:[{r,name,nurseId,matched}], dateCol:[{c,raw,dk,matched}], dateFrom, dateTo}
      diff:null,        // {will_set, will_clear, matched_all, unrecognized, unmatchedNames, unmatchedDates, months, outsideCycle}
      // 파일 업로드 (엑셀/CSV → 서버 파싱 → grid)
      sheets:null,      // [{name, rows}] — /api/parse-table-file 결과
      sheetIdx:0,
      fileName:'',
      // 저장탭 업로드('saved') 전용
      anchorY:null,     // 날짜에 월이 없을 때 해석 기준 + 저장 년월
      anchorM:null,
      anchorTouched:false,
      saveName:'',
    },
    openPastePrev(target){
      this.pastePrev={
        open:true,rawText:'',grid:[],mode:'auto',target:target||'prev',
        hasNameCol:true,hasDateRow:true,matches:null,diff:null,
        sheets:null,sheetIdx:0,fileName:'',
        anchorY:this.year,anchorM:this.month,anchorTouched:false,saveName:'',
      };
      this.$nextTick&&this.$nextTick(()=>{
        const ta=document.getElementById('paste-prev-textarea');
        if(ta)ta.focus();
      });
    },
    closePastePrev(){this.pastePrev.open=false},

    _shiftAlias(){
      // 한글/영문/관용어 → 표준 코드 변환 매핑
      const map={};
      const alias=[
        ['낮','D'],['낮번','D'],['데이','D'],['day','D'],
        ['저녁','E'],['이브닝','E'],['이브','E'],['evening','E'],
        ['중간','중'],['mid','중'],['middle','중'],['중번','중'],
        ['야간','N'],['나이트','N'],['night','N'],['밤','N'],
        ['데차','DC'],['데이차지','DC'],['daycharge','DC'],
        ['이차','EC'],['이브차지','EC'],['evcharge','EC'],
        ['나차','NC'],['나이트차지','NC'],['ncharge','NC'],
        ['휴무','OF'],['오프','OF'],['off','OF'],['o','OF'],
        ['주휴','주'],['week','주'],['w','주'],
        ['연차','V'],['휴가','V'],['연','V'],
        ['생휴','생'],['생리','생'],
        ['병가','병'],
        ['특별','특'],['특가','특'],
        ['공휴','공'],['공가','공'],
        ['법정','법'],['법가','법'],
      ];
      for(const[k,v]of alias)map[k.toLowerCase()]=v;
      return map;
    },

    _normalizeShiftCode(s){
      // 빈값/공백/하이픈 등 → 빈 코드 (해당 셀 비움 의미)
      const raw=(s||'').trim();
      if(!raw||['-','—','x','X','·','/','none','없음'].includes(raw))return null;
      // 정확한 코드 일치 (대소문자 무시)
      const exact=this.shifts.find(sh=>sh.code===raw)||this.shifts.find(sh=>sh.code.toLowerCase()===raw.toLowerCase());
      if(exact)return exact.code;
      // 별칭 매핑
      const alias=this._shiftAlias()[raw.toLowerCase()];
      if(alias){
        const found=this.shifts.find(sh=>sh.code===alias);
        if(found)return found.code;
      }
      // 한 글자가 영문 코드의 첫 글자(예: D)일 수도
      if(raw.length===1){
        const cand=this.shifts.find(sh=>sh.code.toUpperCase()===raw.toUpperCase());
        if(cand)return cand.code;
      }
      return undefined;  // 인식 불가
    },

    // ── 날짜 헤더 해석 (멀티월) ────────────────────────────────
    _parseDateCell(cell){
      // 날짜 셀 → {y,m,d} (y/m는 없으면 null). 인식 불가 시 null.
      const t=(cell||'').trim();
      if(!t)return null;
      let m=t.match(/^(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/);  // 2026-05-03, 2026년 5월 3일
      if(m){const mo=+m[2],d=+m[3];return(mo>=1&&mo<=12&&d>=1&&d<=31)?{y:+m[1],m:mo,d}:null}
      m=t.match(/(\d{1,2})\s*[/.\-월]\s*(\d{1,2})/);                          // 5/3, 5월 3일, 5-3, 5.3
      if(m){const mo=+m[1],d=+m[2];if(mo>=1&&mo<=12&&d>=1&&d<=31)return{y:null,m:mo,d}}
      m=t.match(/(\d{1,2})\s*일/);                                            // 3일
      if(m){const d=+m[1];return(d>=1&&d<=31)?{y:null,m:null,d}:null}
      m=t.match(/^(\d{1,2})$/);                                               // 단순 숫자 (1~31)
      if(m){const d=+m[1];return(d>=1&&d<=31)?{y:null,m:null,d}:null}
      m=t.match(/^(\d{1,2})\s*[(\(]/);                                        // "1(일)", "2(월)" 등
      if(m){const d=+m[1];return(d>=1&&d<=31)?{y:null,m:null,d}:null}
      return null;
    },

    _ymShift(y,m,delta){const t=y*12+(m-1)+delta;return{y:Math.floor(t/12),m:(t%12+12)%12+1}},
    _ymNearestYear(m,anchorY,anchorM){
      // 월만 있을 때 앵커 년월에 가장 가까운 연도 선택 (동률이면 과거 — 기존 표 업로드가 주 용도)
      let best=null;
      for(const y of[anchorY-1,anchorY,anchorY+1]){
        const delta=Math.abs((y*12+m)-(anchorY*12+anchorM));
        if(!best||delta<best.delta||(delta===best.delta&&y<best.y))best={y,delta};
      }
      return best.y;
    },
    _isoOf(y,m,d){
      const dt=new Date(y,m-1,d);
      if(dt.getFullYear()!==y||dt.getMonth()!==m-1||dt.getDate()!==d)return null;  // 2/30 등 실존 안 함
      return`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    },
    _resolveHeaderDates(parsed,anchorY,anchorM){
      // parsed: ({y,m,d}|null)[] → ISO 날짜 문자열|null 배열 (컬럼 정렬 유지).
      // 월이 명시된 셀은 그대로(연도는 앵커에 가장 가까운 해), 일자만 있는 셀은
      // 앞뒤 문맥으로 월을 잇고 일자가 줄어드는 지점을 다음 달로 해석한다.
      const out=new Array(parsed.length).fill(null);
      const idxs=[];
      for(let i=0;i<parsed.length;i++)if(parsed[i])idxs.push(i);
      if(!idxs.length)return out;

      if(idxs.some(i=>parsed[i].m)){
        // ① 명시 월 셀 → 직접 해석, 그 뒤 일자만 셀은 순방향 전파 (감소 = +1개월)
        let ctx=null,prevD=null;
        for(const i of idxs){
          const p=parsed[i];
          if(p.m){
            const y=p.y||this._ymNearestYear(p.m,anchorY,anchorM);
            ctx={y,m:p.m};
            out[i]=this._isoOf(y,p.m,p.d);
          }else if(ctx){
            if(prevD!=null&&p.d<prevD)ctx=this._ymShift(ctx.y,ctx.m,1);
            out[i]=this._isoOf(ctx.y,ctx.m,p.d);
          }
          prevD=p.d;
        }
        // 첫 명시 월 셀보다 앞에 있는 일자만 셀 → 역방향 전파 (증가 = -1개월)
        const firstExpPos=idxs.findIndex(i=>parsed[i].m);
        if(firstExpPos>0){
          const fp=parsed[idxs[firstExpPos]];
          let rctx={y:fp.y||this._ymNearestYear(fp.m,anchorY,anchorM),m:fp.m},rPrevD=fp.d;
          for(let k=firstExpPos-1;k>=0;k--){
            const p=parsed[idxs[k]];
            if(p.d>rPrevD)rctx=this._ymShift(rctx.y,rctx.m,-1);
            out[idxs[k]]=this._isoOf(rctx.y,rctx.m,p.d);
            rPrevD=p.d;
          }
        }
      }else{
        // ② 전부 일자만 → 감소 지점에서 run 분리. 1로 시작하는 첫 run이 앵커 년월,
        //    그 앞 run은 한 달씩 이전, 뒤 run은 한 달씩 다음 (주기 이월 표·여러 달 연속 표 지원)
        const runs=[];let cur=[],prevD=null;
        for(const i of idxs){
          const d=parsed[i].d;
          if(prevD!=null&&d<prevD){runs.push(cur);cur=[]}
          cur.push(i);prevD=d;
        }
        runs.push(cur);
        let anchorIdx=runs.findIndex(r=>parsed[r[0]].d===1);
        if(anchorIdx<0)anchorIdx=0;
        for(let ri=0;ri<runs.length;ri++){
          const{y,m}=this._ymShift(anchorY,anchorM,ri-anchorIdx);
          for(const i of runs[ri])out[i]=this._isoOf(y,m,parsed[i].d);
        }
      }
      return out;
    },

    _parsePasteText(text){
      // 줄바꿈 → 행, 탭 → 셀. 빈 줄은 제거.
      const lines=text.replace(/\r\n/g,'\n').split('\n');
      const grid=lines.map(l=>l.split('\t'));
      // 끝쪽 완전히 빈 줄만 제거 (중간은 유지)
      while(grid.length&&grid[grid.length-1].every(c=>!c.trim()))grid.pop();
      return grid;
    },

    _matchPasteGrid(){
      // 헤더 행/이름 컬럼 자동 감지
      const grid=this.pastePrev.grid;
      if(!grid.length){this.pastePrev.matches=null;this.pastePrev.diff=null;return}

      const anchorY=parseInt(this.pastePrev.anchorY)||this.year;
      const anchorM=parseInt(this.pastePrev.anchorM)||this.month;
      const days=this.scheduleDays;
      const nurseByName={};
      for(const n of this.nurses)nurseByName[(n.name||'').trim()]=n;

      // 요일 행 감지 — 날짜 행 아래 둘째 행에 월/화/수…가 오는 시트 형식 지원.
      // 셀의 80% 이상이 요일 토큰이면 데이터 행이 아니라 헤더로 보고 무시한다.
      const WEEKDAY_TOKENS=new Set(['월','화','수','목','금','토','일','요일']);
      const isWeekdayRow=(row,startC)=>{
        const cells=(row||[]).slice(startC).map(c=>(c||'').trim().replace(/[()]/g,'')).filter(Boolean);
        if(cells.length<3)return false;
        return cells.filter(c=>WEEKDAY_TOKENS.has(c)).length/cells.length>=0.8;
      };

      const tryMatch=(useNameCol,useDateRow)=>{
        const startR=useDateRow?1:0;
        const startC=useNameCol?1:0;
        let nameMatches=0,dateMatches=0;
        const nameRow=[];
        const dateCol=[];

        if(useNameCol){
          for(let r=startR;r<grid.length;r++){
            if(isWeekdayRow(grid[r],startC)){
              nameRow.push({r,name:'',nurseId:null,matched:false,weekdayHeader:true});
              continue;
            }
            const raw=(grid[r][0]||'').trim();
            const stripped=raw.replace(/^\*+/,'').trim();  // 게스트모드 데이터의 '*' 접두 제거
            const n=nurseByName[raw]||nurseByName[stripped];
            nameRow.push({r,name:raw,nurseId:n?.id||null,matched:!!n});
            if(n)nameMatches++;
          }
        }
        if(useDateRow){
          const ncols=Math.max(...grid.map(rw=>rw.length));
          const raws=[],parsed=[];
          for(let c=startC;c<ncols;c++){
            const raw=(grid[0][c]||'').trim();
            raws.push(raw);
            parsed.push(this._parseDateCell(raw));
          }
          const resolved=this._resolveHeaderDates(parsed,anchorY,anchorM);
          for(let k=0;k<raws.length;k++){
            const dk=resolved[k];
            dateCol.push({c:startC+k,raw:raws[k],dk,matched:!!dk});
            if(dk)dateMatches++;
          }
        }
        return{useNameCol,useDateRow,nameMatches,dateMatches,nameRow,dateCol,score:nameMatches*2+dateMatches};
      };

      const auto=this.pastePrev.mode==='auto';
      let best;
      if(auto){
        const cands=[
          tryMatch(true,true),
          tryMatch(true,false),
          tryMatch(false,true),
          tryMatch(false,false),
        ];
        best=cands.reduce((a,b)=>b.score>a.score?b:a);
        this.pastePrev.hasNameCol=best.useNameCol;
        this.pastePrev.hasDateRow=best.useDateRow;
      }else{
        best=tryMatch(this.pastePrev.hasNameCol,this.pastePrev.hasDateRow);
      }
      const matchedDks=best.dateCol.filter(x=>x.dk).map(x=>x.dk).sort();
      best.dateFrom=matchedDks[0]||null;
      best.dateTo=matchedDks[matchedDks.length-1]||null;
      this.pastePrev.matches=best;

      // 차이 계산
      const willSet=[];
      const willClear=[];
      const matchedAll=[]; // 인식된 모든 (간호사,날짜,코드) — 위시/저장탭 업로드용 (prev 비교 무관)
      const unrecognized=new Set();
      const startR=best.useDateRow?1:0;
      const startC=best.useNameCol?1:0;

      // 날짜 헤더 없는 경우: 당월 1일부터 시작해서 데이터 매핑
      // (사용자가 보통 1일~말일 시퀀스로 paste한다고 가정)
      const monthStartIdx=days.findIndex(d=>!this.isOverflow(d)&&d.getDate()===1);
      const fallbackStart=monthStartIdx>=0?monthStartIdx:0;
      const fallbackCols=days.slice(fallbackStart).map((d,i)=>({c:startC+i,dk:this.dayKey(d),matched:!this.isOverflow(d)}));

      // name-date 모드: 매칭된 행/열만 처리
      if(best.useNameCol||best.useDateRow){
        for(let ri=0;ri<best.nameRow.length;ri++){
          const nameInfo=best.nameRow[ri];
          if(!nameInfo.matched)continue;
          const nid=nameInfo.nurseId;
          const r=nameInfo.r;
          const cols=best.useDateRow?best.dateCol:fallbackCols;
          for(const ci of cols){
            if(!ci.matched)continue;
            const cell=(grid[r]?.[ci.c]||'').trim();
            const code=this._normalizeShiftCode(cell);
            const oldShift=this.prevSchedule[nid]?.[ci.dk]||'';
            if(code===null){
              // 명시적으로 비우기
              if(oldShift)willClear.push({nid,name:nameInfo.name,dk:ci.dk,oldShift});
            }else if(code===undefined){
              if(cell)unrecognized.add(cell);
            }else{
              matchedAll.push({nid,name:nameInfo.name,dk:ci.dk,code});
              if(code!==oldShift)willSet.push({nid,name:nameInfo.name,dk:ci.dk,oldShift,newShift:code});
            }
          }
        }
      }else if(this._focusedCell){
        // cursor paste: 포커스 셀에서 우/하 방향
        const{nIdx,dIdx}=this._focusedCell;
        for(let r=0;r<grid.length;r++){
          const nurse=this.nurses[nIdx+r];
          if(!nurse)continue;
          for(let c=0;c<(grid[r]||[]).length;c++){
            const day=days[dIdx+c];
            if(!day||this.isOverflow(day))continue;
            const cell=(grid[r][c]||'').trim();
            const code=this._normalizeShiftCode(cell);
            const dk=this.dayKey(day);
            const oldShift=this.prevSchedule[nurse.id]?.[dk]||'';
            if(code===null){
              if(oldShift)willClear.push({nid:nurse.id,name:nurse.name,dk,oldShift});
            }else if(code===undefined){
              if(cell)unrecognized.add(cell);
            }else{
              matchedAll.push({nid:nurse.id,name:nurse.name,dk,code});
              if(code!==oldShift)willSet.push({nid:nurse.id,name:nurse.name,dk,oldShift,newShift:code});
            }
          }
        }
      }

      const unmatchedNames=best.nameRow?best.nameRow.filter(x=>!x.matched&&x.name&&!x.weekdayHeader).map(x=>x.name):[];
      const unmatchedDates=best.dateCol?best.dateCol.filter(x=>!x.matched&&x.raw).map(x=>x.raw):[];

      // 월별 적용 건수 + 당월 주기 밖 건수 — 멀티월 붙여넣기의 결과를 명시적으로 보여준다
      const affected=this.pastePrev.target==='prev'
        ?[...willSet,...willClear]
        :matchedAll;
      const monthCnt={};
      const cycleKeys=this._cycleDateKeys();
      let outsideCycle=0;
      for(const it of affected){
        const ym=it.dk.slice(0,7);
        monthCnt[ym]=(monthCnt[ym]||0)+1;
        if(!cycleKeys.has(it.dk))outsideCycle++;
      }
      const months=Object.keys(monthCnt).sort().map(ym=>({ym,label:`${+ym.slice(0,4)}년 ${+ym.slice(5,7)}월`,count:monthCnt[ym]}));

      this.pastePrev.diff={will_set:willSet,will_clear:willClear,matched_all:matchedAll,unrecognized:[...unrecognized],unmatchedNames,unmatchedDates,months,outsideCycle};
    },

    _afterGridChange(){
      this._matchPasteGrid();
      this._maybeAutoAnchor();
    },
    _maybeAutoAnchor(){
      // 저장탭 업로드: 날짜에 월이 명시돼 있으면 저장 년월을 표에서 자동 감지 (1회 재해석)
      if(this.pastePrev.target!=='saved'||this.pastePrev.anchorTouched)return;
      const cols=this.pastePrev.matches?.dateCol||[];
      const cnt={};
      for(const c of cols)if(c.dk){const ym=c.dk.slice(0,7);cnt[ym]=(cnt[ym]||0)+1}
      let best=null;
      for(const[ym,n]of Object.entries(cnt))if(!best||n>best.n)best={ym,n};
      if(!best)return;
      const y=+best.ym.slice(0,4),m=+best.ym.slice(5,7);
      if(y===(parseInt(this.pastePrev.anchorY)||this.year)&&m===(parseInt(this.pastePrev.anchorM)||this.month))return;
      this.pastePrev.anchorY=y;this.pastePrev.anchorM=m;
      this._matchPasteGrid();
    },

    onPasteTextChange(){
      // 직접 붙여넣기/타이핑은 파일 로드 상태를 대체한다
      this.pastePrev.sheets=null;this.pastePrev.fileName='';this.pastePrev.sheetIdx=0;
      this.pastePrev.grid=this._parsePasteText(this.pastePrev.rawText);
      this._afterGridChange();
    },

    onPasteRawPaste(event){
      // textarea의 paste 이벤트 가로채서 자동 분석
      // (default paste 동작 진행 후 다음 tick에 분석)
      setTimeout(()=>this.onPasteTextChange(),0);
    },

    // ── 엑셀/CSV 파일에서 읽기 (서버 파싱 → 붙여넣기와 동일 파이프라인) ──
    async onPasteFileSelect(event){
      const file=event.target?.files?.[0];
      if(event.target)event.target.value='';
      if(!file)return;
      await this._loadPasteFile(file);
    },
    async _loadPasteFile(file){
      if(/\.xls$/i.test(file.name)){
        this.toast('구형 xls(97-2003)는 지원되지 않습니다 — 엑셀에서 xlsx로 다시 저장하거나, 표를 복사해 붙여넣으세요','warn',6000);
        return;
      }
      if(!/\.(xlsx|xlsm|csv|tsv|txt)$/i.test(file.name)){
        this.toast('xlsx / csv / tsv 파일만 지원합니다 (또는 표를 복사해 붙여넣으세요)','warn',5000);
        return;
      }
      const loading=this.toast(`'${file.name}' 읽는 중...`,'loading');
      try{
        const b64=this._arrayBufferToBase64(await file.arrayBuffer());
        const res=await this.api('POST','/api/parse-table-file',{file_b64:b64,filename:file.name});
        const sheets=(res.sheets||[]).filter(s=>s.rows&&s.rows.length);
        this.dismissToast(loading);
        if(!sheets.length){this.toast('파일에서 표를 찾지 못했습니다','warn');return}
        // 데이터 셀이 가장 많은 시트를 기본 선택
        let bestIdx=0,bestScore=-1;
        sheets.forEach((s,i)=>{
          const sc=s.rows.reduce((a,r)=>a+r.filter(c=>String(c??'').trim()).length,0);
          if(sc>bestScore){bestScore=sc;bestIdx=i}
        });
        this.pastePrev.sheets=sheets;
        this.pastePrev.fileName=file.name;
        this.pastePrev.rawText='';
        this._selectPasteSheet(bestIdx);
      }catch(e){
        this.dismissToast(loading);
        this.toast(`파일 읽기 실패: ${e.message}`,'error',6000);
      }
    },
    _selectPasteSheet(i){
      const sheet=this.pastePrev.sheets?.[i];
      if(!sheet)return;
      this.pastePrev.sheetIdx=i;
      this.pastePrev.grid=sheet.rows.map(r=>r.map(c=>String(c??'')));
      this._afterGridChange();
    },

    /* 붙여넣은 표에 있는데 간호사 목록엔 없는 이름 — 그냥 추가해 주는 게 낫다.
     * (없는 사람은 조용히 버려져서 "왜 몇 명이 비지?" 하고 헤매게 된다) */
    async addUnmatchedNurses(){
      const names=[...new Set((this.pastePrev.diff?.unmatchedNames||[])
        .map(s=>String(s).replace(/^\*+/,'').trim()).filter(Boolean))]
        .filter(n=>!this.nurses.some(x=>x.name===n));
      if(!names.length){this.toast('추가할 이름이 없습니다','warn');return}
      if(!confirm(`간호사 ${names.length}명을 새로 추가합니다.\n\n${names.join(', ')}\n\n`+
                  `근무 자격은 전부 가능으로, 순서(시니어리티)는 맨 뒤로 들어갑니다.\n계속할까요?`))return;
      const loading=this.toast('간호사 추가 중...','loading');
      let added=0;
      try{
        let seniority=this.nurses.length;
        for(const name of names){
          await this.api('POST','/api/nurses',{
            id:crypto.randomUUID(),name,group:'',gender:'female',
            capable_shifts:['DC','D','EC','E','NC','N'],
            is_night_shift:false,night_months:{},seniority:seniority++,wishes:{},
            juhu_day:null,juhu_auto_rotate:true,is_trainee:false,training_end_date:null,
            preceptor_id:null,start_date:null,end_date:null,is_pregnant:false,pregnancy:{},
          });
          added++;
        }
        await this.loadNurses();
        this._matchPasteGrid();          // 새 이름까지 포함해 다시 맞춘다
        this.dismissToast(loading);
        this.toast(`간호사 ${added}명 추가 — 다시 맞췄습니다. 아래에서 확인하고 적용하세요`,'info',4500);
      }catch(e){
        this.dismissToast(loading);
        await this.loadNurses().catch(()=>{});
        this.toast(`추가 중 실패 (${added}명까지 됨): ${e.message}`,'error',5000);
      }
    },

    applyPastePrev(){
      const diff=this.pastePrev.diff;
      if(!diff)return;
      if(this.pastePrev.target==='saved'){this._applyPasteSaved();return}
      if(this.pastePrev.target==='wish'){
        // 위시 임포트: 사전입력과 비교하지 않고 인식된 전 셀을 희망으로 등록.
        // 휴무/휴가 계열 코드는 'OFF 희망'으로 정규화 (배점 규칙의 OFF 위시 의미)
        const cells=diff.matched_all||[];
        if(!cells.length){this.toast('인식된 위시가 없습니다','warn');return}
        const OFF_LIKE=['OF','주','P1','V','생','특','공','법','병'];
        const updated=new Set();
        for(const it of cells){
          const nurse=this.nurses.find(n=>n.id===it.nid);if(!nurse)continue;
          if(!nurse.wishes)nurse.wishes={};
          nurse.wishes[it.dk]=OFF_LIKE.includes(it.code)?'OFF':it.code;
          updated.add(it.nid);
        }
        Promise.all([...updated].map(nid=>this.api('POST','/api/nurses',this.nurses.find(n=>n.id===nid))))
          .then(()=>this.toast(`★ 희망근무 ${cells.length}건 등록 (소프트 — 가능하면 반영, 서버 저장됨)`,'info',4500))
          .catch(()=>this.toast('희망은 화면에 반영됐지만 일부 서버 저장에 실패했습니다','error'));
        this.closePastePrev();return;
      }
      const totalChanges=diff.will_set.length+diff.will_clear.length;
      if(!totalChanges){this.toast('적용할 변경 사항이 없습니다','warn');return}
      this._pushUndo();
      for(const item of diff.will_set){
        if(!this.prevSchedule[item.nid])this.prevSchedule[item.nid]={};
        this.prevSchedule[item.nid][item.dk]=item.newShift;
      }
      for(const item of diff.will_clear){
        if(this.prevSchedule[item.nid])delete this.prevSchedule[item.nid][item.dk];
      }
      this._checkViolations&&this._checkViolations();
      const monthsNote=(diff.months||[]).length>1
        ?` (${diff.months.map(x=>`${+x.ym.slice(5,7)}월 ${x.count}`).join(' · ')})`
        :'';
      this.toast(`사전입력 ${diff.will_set.length}건 설정${diff.will_clear.length?', '+diff.will_clear.length+'건 비움':''}${monthsNote}`,'info',monthsNote?4500:3000);
      this.closePastePrev();
    },

    // ── 저장탭 업로드: 인식된 표를 그대로 저장된 근무표로 등록 ──
    async _applyPasteSaved(){
      const diff=this.pastePrev.diff;
      const cells=diff?.matched_all||[];
      if(!cells.length){this.toast('인식된 근무가 없습니다','warn');return}
      const y=parseInt(this.pastePrev.anchorY)||this.year;
      const m=parseInt(this.pastePrev.anchorM)||this.month;
      const schedule={};
      const nids=new Set();
      for(const it of cells){(schedule[it.nid]=schedule[it.nid]||{})[it.dk]=it.code;nids.add(it.nid)}
      const monthsLabel=(diff.months||[]).map(x=>`${x.label} ${x.count}건`).join(' · ');
      if(!confirm(`${cells.length}건(간호사 ${nids.size}명)을 ${y}년 ${m}월 근무표로 저장합니다.\n${monthsLabel}\n\n저장 탭 목록에 새 항목으로 추가됩니다. 계속할까요?`))return;
      const name=(this.pastePrev.saveName||'').trim()||`${y}년 ${m}월 (업로드)`;
      const loading=this.toast('저장 중...','loading');
      try{
        await this.api('POST','/api/schedules',{
          year:y,month:m,nurses:this.nurses,requirements:this.requirements,rules:this.rules,
          schedule,name,
          // 이 표의 실제 인원수를 일별 필요 인원으로 함께 저장 —
          // 불러온 뒤 재조정/재생성할 때 설정 기본값 대신 이 표가 기준이 되게
          prev_day_reqs:this._reqFromSchedule(schedule),
        });
        await this.loadSavedList();
        this.dismissToast(loading);
        this.closePastePrev();
        this.activeTab='saved';
        this.toast(`'${name}' 저장 완료 — 목록에서 불러오기로 열 수 있습니다`,'success',4500);
      }catch(e){
        this.dismissToast(loading);
        this.toast(`저장 실패: ${e.message}`,'error',6000);
      }
    },

  };
};
