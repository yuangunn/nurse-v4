/* ────────────────────────────────────────────────────────────────────────────
 * 엑셀 사전입력 붙여넣기 — 클립보드 표 파싱·그리드 매칭·적용 (사전입력 탭)
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
      target:'prev',    // 'prev'=사전입력(확정) | 'wish'=희망근무(소프트 ★)
      hasNameCol:true,
      hasDateRow:true,
      matches:null,     // {nameRow:[{r,name,nurseId,matched}], dateCol:[{c,day,dk,matched}]}
      diff:null,        // {will_set, will_clear, matched_all, unrecognized, unmatchedNames, unmatchedDates}
    },
    openPastePrev(target){
      this.pastePrev={open:true,rawText:'',grid:[],mode:'auto',target:target||'prev',hasNameCol:true,hasDateRow:true,matches:null,diff:null};
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

    _parseDateCell(cell){
      // "5/3", "5월 3일", "3", "2026-05-03" 등에서 일자 숫자 추출
      const t=(cell||'').trim();
      if(!t)return null;
      // YYYY-MM-DD
      let m=t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      if(m)return parseInt(m[3],10);
      // M/D or M-D
      m=t.match(/(\d{1,2})\s*[/.\-월]\s*(\d{1,2})/);
      if(m)return parseInt(m[2],10);
      // (M월 D일)
      m=t.match(/(\d{1,2})\s*일/);
      if(m)return parseInt(m[1],10);
      // 단순 숫자 (1~31)
      m=t.match(/^(\d{1,2})$/);
      if(m){const d=parseInt(m[1],10);return(d>=1&&d<=31)?d:null}
      // "1(일)", "2(월)" 등
      m=t.match(/^(\d{1,2})\s*[(\(]/);
      if(m){const d=parseInt(m[1],10);return(d>=1&&d<=31)?d:null}
      return null;
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

      // 옵션별 점수 계산: hasNameCol / hasDateRow 조합 4가지
      const days=this.scheduleDays;
      const dayByNum={};
      for(const d of days){
        if(this.isOverflow(d))continue;  // 당월에 한정
        dayByNum[d.getDate()]=d;
      }
      const nurseByName={};
      for(const n of this.nurses)nurseByName[(n.name||'').trim()]=n;

      const tryMatch=(useNameCol,useDateRow)=>{
        const startR=useDateRow?1:0;
        const startC=useNameCol?1:0;
        let nameMatches=0,dateMatches=0;
        const nameRow=[];
        const dateCol=[];

        if(useNameCol){
          for(let r=startR;r<grid.length;r++){
            const raw=(grid[r][0]||'').trim();
            const stripped=raw.replace(/^\*+/,'').trim();  // 게스트모드 데이터의 '*' 접두 제거
            const n=nurseByName[raw]||nurseByName[stripped];
            nameRow.push({r,name:raw,nurseId:n?.id||null,matched:!!n});
            if(n)nameMatches++;
          }
        }
        if(useDateRow){
          const ncols=Math.max(...grid.map(rw=>rw.length));
          for(let c=startC;c<ncols;c++){
            const raw=(grid[0][c]||'').trim();
            const dnum=this._parseDateCell(raw);
            const day=dnum?dayByNum[dnum]:null;
            dateCol.push({c,raw,day,dk:day?this.dayKey(day):null,matched:!!day});
            if(day)dateMatches++;
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
      this.pastePrev.matches=best;

      // 차이 계산
      const willSet=[];
      const willClear=[];
      const matchedAll=[]; // 인식된 모든 (간호사,날짜,코드) — 위시 임포트용 (prev 비교 무관)
      const unrecognized=new Set();
      const startR=best.useDateRow?1:0;
      const startC=best.useNameCol?1:0;

      // 날짜 헤더 없는 경우: 당월 1일부터 시작해서 데이터 매핑
      // (사용자가 보통 1일~말일 시퀀스로 paste한다고 가정)
      const monthStartIdx=days.findIndex(d=>!this.isOverflow(d)&&d.getDate()===1);
      const fallbackStart=monthStartIdx>=0?monthStartIdx:0;
      const fallbackCols=days.slice(fallbackStart).map((d,i)=>({c:startC+i,day:d,dk:this.dayKey(d),matched:!this.isOverflow(d)}));

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

      const unmatchedNames=best.nameRow?best.nameRow.filter(x=>!x.matched&&x.name).map(x=>x.name):[];
      const unmatchedDates=best.dateCol?best.dateCol.filter(x=>!x.matched&&x.raw).map(x=>x.raw):[];

      this.pastePrev.diff={will_set:willSet,will_clear:willClear,matched_all:matchedAll,unrecognized:[...unrecognized],unmatchedNames,unmatchedDates};
    },

    onPasteTextChange(){
      this.pastePrev.grid=this._parsePasteText(this.pastePrev.rawText);
      this._matchPasteGrid();
    },

    onPasteRawPaste(event){
      // textarea의 paste 이벤트 가로채서 자동 분석
      // (default paste 동작 진행 후 다음 tick에 분석)
      setTimeout(()=>this.onPasteTextChange(),0);
    },

    applyPastePrev(){
      const diff=this.pastePrev.diff;
      if(!diff)return;
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
      this.toast(`사전입력 ${diff.will_set.length}건 설정${diff.will_clear.length?', '+diff.will_clear.length+'건 비움':''}`,'info');
      this.closePastePrev();
    },

  };
};
