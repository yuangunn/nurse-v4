/* ────────────────────────────────────────────────────────────────────────────
 * 분석 모듈 — 인원 과부족 분석 + 주휴 추천 배분 (분석 탭)
 *
 * 사용: app() 반환 객체에 `...AnalysisModule()` 로 스프레드.
 * 의존: this.nurses/requirements/prevSchedule/scheduleDays/holidays/analysisResult
 *       /juhuRecommendation/analysisRunning + this.getDayWeekKey()/dayKey() 등 (전부 this.*)
 * ─────────────────────────────────────────────────────────────────────────── */
window.AnalysisModule = function() {
  return {
    // ── 분석 탭 ─────────────────────────────────────────────
    runAnalysis(){
      this.analysisRunning=true;
      try{
        this.analysisResult=this._analyzeStaffing();
        this.juhuRecommendation=this._recommendJuhu(this.analysisResult);
      }catch(e){console.error('Analysis error:',e);this.analysisResult=null;this.juhuRecommendation=null}
      this.analysisRunning=false;
    },

    _getReqForDay(day){
      const wk=this.getDayWeekKey(day);
      const base=this.requirements[wk]||{};
      const dk=this.dayKey(day);
      const override=this.prevDayReqs[dk]||{};
      const D=(override.D!==undefined?override.D:base.D)||0;
      const E=(override.E!==undefined?override.E:base.E)||0;
      const N=(override.N!==undefined?override.N:base.N)||0;
      const result={D,E,N,total:D+E+N};
      // 추가 자동배정 근무의 요구사항
      for(const code of this.reqShiftCodes){
        if(code==='D'||code==='E'||code==='N')continue;
        const val=(override[code]!==undefined?override[code]:base[code])||0;
        result[code]=val;
        result.total+=val;
      }
      return result;
    },

    _analyzeStaffing(){
      const days=this.scheduleDays;
      const first=new Date(this.year,this.month-1,1);
      const last=new Date(this.year,this.month,0);
      const dayNames=['일','월','화','수','목','금','토'];

      // 시프트 분류
      const restCodes=this.shifts.filter(s=>s.period==='rest').map(s=>s.code);
      const leaveCodes=this.shifts.filter(s=>s.period==='leave').map(s=>s.code);
      const offCodes=[...restCodes,...leaveCodes];

      const dayAnalysis=[];
      for(const day of days){
        const isThisMonth=day.getMonth()===this.month-1&&day.getFullYear()===this.year;
        const dk=this.dayKey(day);
        const req=this._getReqForDay(day);

        // 날짜별 재적 간호사만 카운트 (전입/전출 범위 내)
        const activeNurses=this.nurses.filter(n=>!this.isNurseInactive(n,day));
        const totalNurses=activeNurses.length;

        // 사전입력 카운트 (재적 간호사만)
        let preWork=0,preRest=0,preLeave=0,preJuhu=0,preOF=0;
        for(const nurse of activeNurses){
          const val=(this.prevSchedule[nurse.id]||{})[dk];
          if(!val)continue;
          if(val==='주')preJuhu++;
          else if(val==='OF')preOF++;
          else if(restCodes.includes(val))preRest++;
          else if(leaveCodes.includes(val))preLeave++;
          else preWork++;
        }
        const preFixed=preWork+preRest+preLeave+preJuhu+preOF;
        const freeNurses=totalNurses-preFixed;
        const remainReq=Math.max(0,req.total-preWork);
        const slack=freeNurses-remainReq;

        dayAnalysis.push({
          day, dk, isThisMonth,
          date:day.getDate(),
          dow:day.getDay(),
          dowName:dayNames[day.getDay()],
          reqD:req.D, reqE:req.E, reqN:req.N, reqTotal:req.total, reqExtra:req,
          preWork, preRest, preLeave, preJuhu, preOF, preFixed,
          freeNurses, remainReq, slack,
          weekIdx:Math.floor(this._daysSinceRef(day)/7),
          cycle:this.getCycleNum(day),
        });
      }

      // 주별 집계 (모든 주기 날짜 포함 — overflow 포함)
      const weekMap=new Map();
      for(const da of dayAnalysis){
        if(!weekMap.has(da.weekIdx))weekMap.set(da.weekIdx,{weekIdx:da.weekIdx,cycle:da.cycle,days:[],totalReq:0,totalSlack:0,juhuAssigned:0,ofAssigned:0});
        const w=weekMap.get(da.weekIdx);
        w.days.push(da);
        w.totalReq+=da.reqTotal;w.totalSlack+=da.slack;w.juhuAssigned+=da.preJuhu;w.ofAssigned+=da.preOF;
      }
      const weeks=[...weekMap.values()].sort((a,b)=>a.weekIdx-b.weekIdx);

      // 경고 (모든 날짜 대상)
      const warnings=[];
      for(const da of dayAnalysis){
        if(da.slack<0)warnings.push({type:'danger',msg:`${da.day.getMonth()+1}/${da.date}(${da.dowName}) 인원 부족: 필요 ${da.reqTotal}명, 가용 ${da.freeNurses+da.preWork}명`});
        else if(da.slack<2)warnings.push({type:'warn',msg:`${da.day.getMonth()+1}/${da.date}(${da.dowName}) 여유 부족 (${da.slack}명) — 주휴/OF 배치 공간 빡빡`});
      }

      // 사전입력 구조 검사 — 생성 실패를 부르는 주별 OF/주 패턴을 미리 짚는다
      // (자동으로 바꾸지 않는다 — 주휴는 사람이 결정. 여기서는 알려주기만.)
      warnings.push(...this._prevStructureWarnings());

      return {days:dayAnalysis, weeks, warnings, totalNurses:this.nurses.length};
    },

    _prevStructureWarnings(){
      const out=[];
      const days=this.scheduleDays;
      if(!days.length||!this.nurses.length)return out;
      const weeks=[];
      for(let i=0;i+6<days.length;i+=7)weeks.push(days.slice(i,i+7));
      let count=0;
      for(const nurse of this.nurses){
        if(this.isNightThisMonth&&this.isNightThisMonth(nurse))continue; // 야간전담은 OF 규칙 제외
        const pre=this.prevSchedule[nurse.id]||{};
        for(let wi=0;wi<weeks.length;wi++){
          const wd=weeks[wi].filter(d=>!this.isOverflow(d));
          if(!wd.length)continue;
          const codes=wd.map(d=>pre[this.dayKey(d)]||'');
          const ofs=codes.filter(c=>c==='OF').length;
          const jus=codes.filter(c=>c==='주').length;
          const filled=codes.filter(Boolean).length;
          const full=wd.length===7;
          if(ofs>1){
            count++;
            const hint=jus===0?" — 하나를 '주'로 바꾸면 규칙에 맞습니다 (주휴 배치는 직접 결정)":'';
            out.push({type:'danger',msg:`${nurse.name}: ${wi+1}주차 OF ${ofs}회 — 생성 규칙은 주당 1회${hint}`});
          }else if(full&&filled===7&&ofs===0&&!wd.some(d=>this.isHoliday(d))){
            // 공휴일 포함 주의 OF 0회는 오프특근(제1원칙 3)이라 경고하지 않는다
            count++;
            out.push({type:'danger',msg:`${nurse.name}: ${wi+1}주차 OF 0회 (모든 칸 입력됨) — 생성 규칙은 주당 정확히 1회`});
          }
          if(count>=12){
            out.push({type:'warn',msg:'… 사전입력 구조 경고가 더 있습니다 (12건까지만 표시)'});
            return out;
          }
        }
      }
      return out;
    },

    _recommendJuhu(analysis){
      if(!analysis)return null;
      const {days,weeks,totalNurses}=analysis;
      const nurses=this.nurses;
      const assignments={};
      const warnings=[];

      // 일자별 동적 여유도 (추천할 때마다 갱신)
      const daySlack={};
      for(const da of days){
        daySlack[da.dk]={...da,currentSlack:da.slack};
      }

      // 주를 4주 period로 그룹핑
      const periodMap=new Map();
      for(const week of weeks){
        const period=Math.floor(week.weekIdx/4);
        if(!periodMap.has(period))periodMap.set(period,[]);
        periodMap.get(period).push(week);
      }
      const periods=[...periodMap.entries()].sort((a,b)=>a[0]-b[0]);

      // 1단계: 이미 사전입력된 주휴 수집
      const nurseExistingJuhu={};  // nurseId → Set of weekIdx
      for(const nurse of nurses){
        nurseExistingJuhu[nurse.id]=new Set();
        for(const week of weeks){
          for(const wd of week.days){
            const val=(this.prevSchedule[nurse.id]||{})[wd.dk];
            if(val==='주'){
              nurseExistingJuhu[nurse.id].add(week.weekIdx);
              if(!assignments[nurse.id])assignments[nurse.id]=[];
              assignments[nurse.id].push({day:wd.day,dk:wd.dk,date:wd.date,dow:wd.dow,dowName:wd.dowName,cycle:wd.cycle,weekIdx:week.weekIdx,existing:true});
            }
          }
        }
      }

      // 2단계: juhu_day 설정된 간호사 — 4주 동일 요일 + period 간 -1 시프트
      const nurseAssignedWeeks={};  // nurseId → Set of weekIdx (배정 완료)
      for(const n of nurses)nurseAssignedWeeks[n.id]=new Set(nurseExistingJuhu[n.id]);

      for(const nurse of nurses){
        const jd=nurse.juhu_day;
        if(jd===null||jd===undefined)continue;

        for(const[periodIdx,periodWeeks]of periods){
          for(const week of periodWeeks){
            if(nurseAssignedWeeks[nurse.id].has(week.weekIdx))continue;
            const weekDays=week.days;
            if(!weekDays.length)continue;

            let effectiveDay=jd;
            if(nurse.juhu_auto_rotate!==false){
              effectiveDay=((jd-periodIdx)%7+7)%7;
            }
            const target=weekDays.find(d=>d.dow===effectiveDay);
            if(target&&daySlack[target.dk]&&daySlack[target.dk].currentSlack>0){
              if(!assignments[nurse.id])assignments[nurse.id]=[];
              assignments[nurse.id].push({day:target.day,dk:target.dk,date:target.date,dow:target.dow,dowName:target.dowName,cycle:target.cycle,weekIdx:week.weekIdx,existing:false});
              daySlack[target.dk].currentSlack--;
              nurseAssignedWeeks[nurse.id].add(week.weekIdx);
            }
          }
        }
      }

      // 3단계: juhu_day 없는 간호사 — 첫 period에서 최적 요일 선정 후 4주 유지, 다음 period에서 -1
      const unsetNurses=nurses.filter(n=>n.juhu_day===null||n.juhu_day===undefined);

      // 첫 period에서 요일별 여유도 합산 → 가장 여유로운 요일부터 배정
      if(unsetNurses.length>0&&periods.length>0){
        const firstPeriodIdx=periods[0][0];
        const firstPeriodWeeks=periods[0][1];

        // 요일별 누적 여유도 계산 (첫 period 기준)
        const dowSlackSum={};  // dow → 총 여유도
        for(let dow=0;dow<7;dow++)dowSlackSum[dow]=0;
        for(const week of firstPeriodWeeks){
          for(const wd of week.days){
            dowSlackSum[wd.dow]+=(daySlack[wd.dk]?.currentSlack||0);
          }
        }

        // 각 간호사에게 요일 배정 (여유도 + 그룹 균형 고려)
        const dowAssignCount={};  // dow → 배정된 간호사 수
        const dowGroupCount={};   // dow → { groupName → count }
        for(let dow=0;dow<7;dow++){dowAssignCount[dow]=0;dowGroupCount[dow]={}}

        // 간호사를 미배정 주 많은 순으로 정렬
        const sortedUnset=[...unsetNurses].sort((a,b)=>{
          const aUnassigned=weeks.filter(w=>!nurseAssignedWeeks[a.id].has(w.weekIdx)&&w.days.length>0).length;
          const bUnassigned=weeks.filter(w=>!nurseAssignedWeeks[b.id].has(w.weekIdx)&&w.days.length>0).length;
          return bUnassigned-aUnassigned;
        });

        for(const nurse of sortedUnset){
          // 이미 모든 주에 주휴 배정 완료된 간호사는 스킵
          const hasUnassigned=weeks.some(w=>!nurseAssignedWeeks[nurse.id].has(w.weekIdx)&&w.days.length>0);
          if(!hasUnassigned)continue;

          const nurseGroup=nurse.group||'';
          const candidates=[];
          for(let dow=0;dow<7;dow++){
            let feasibleWeeks=0;
            for(const[periodIdx,periodWeeks]of periods){
              const shiftedDow=((dow-(periodIdx-firstPeriodIdx))%7+7)%7;
              for(const week of periodWeeks){
                if(nurseAssignedWeeks[nurse.id].has(week.weekIdx))continue;
                const wd=week.days.find(d=>d.dow===shiftedDow);
                if(wd&&daySlack[wd.dk]&&daySlack[wd.dk].currentSlack>0)feasibleWeeks++;
              }
            }
            if(feasibleWeeks===0)continue;

            // 점수: 여유도 합 - 총 배정 수 페널티 - 같은 그룹 배정 수 페널티 (그룹 균형)
            const sameGroupOnDow=dowGroupCount[dow][nurseGroup]||0;
            const score=dowSlackSum[dow]-dowAssignCount[dow]*2-sameGroupOnDow*4;
            candidates.push({dow,score,feasibleWeeks});
          }

          if(candidates.length===0){
            warnings.push({type:'danger',msg:`${nurse.name}: 주휴 배정 가능한 요일이 없습니다`});
            continue;
          }

          // 최고 점수 요일 선택
          candidates.sort((a,b)=>b.score-a.score||b.feasibleWeeks-a.feasibleWeeks);
          const chosenDow=candidates[0].dow;
          dowAssignCount[chosenDow]++;
          if(!dowGroupCount[chosenDow][nurseGroup])dowGroupCount[chosenDow][nurseGroup]=0;
          dowGroupCount[chosenDow][nurseGroup]++;

          // 모든 period에 걸쳐 배정 (4주 동일 요일, period 간 -1 시프트)
          for(const[periodIdx,periodWeeks]of periods){
            const shiftedDow=((chosenDow-(periodIdx-firstPeriodIdx))%7+7)%7;
            for(const week of periodWeeks){
              if(nurseAssignedWeeks[nurse.id].has(week.weekIdx))continue;
              const weekDays=week.days;
              if(!weekDays.length)continue;

              const target=weekDays.find(d=>d.dow===shiftedDow);
              if(target&&daySlack[target.dk]&&daySlack[target.dk].currentSlack>0){
                if(!assignments[nurse.id])assignments[nurse.id]=[];
                assignments[nurse.id].push({day:target.day,dk:target.dk,date:target.date,dow:target.dow,dowName:target.dowName,cycle:target.cycle,weekIdx:week.weekIdx,existing:false});
                daySlack[target.dk].currentSlack--;
                nurseAssignedWeeks[nurse.id].add(week.weekIdx);
              }else if(target){
                // 여유 없으면 같은 주 다른 날 중 가장 여유로운 날 대체
                const fallback=weekDays
                  .filter(d=>daySlack[d.dk]&&daySlack[d.dk].currentSlack>0)
                  .sort((a,b)=>daySlack[b.dk].currentSlack-daySlack[a.dk].currentSlack);
                if(fallback.length>0){
                  const fb=fallback[0];
                  if(!assignments[nurse.id])assignments[nurse.id]=[];
                  assignments[nurse.id].push({day:fb.day,dk:fb.dk,date:fb.date,dow:fb.dow,dowName:fb.dowName,cycle:fb.cycle,weekIdx:week.weekIdx,existing:false});
                  daySlack[fb.dk].currentSlack--;
                  nurseAssignedWeeks[nurse.id].add(week.weekIdx);
                  warnings.push({type:'warn',msg:`${nurse.name}: ${fb.cycle}주기 ${fb.date}일 — 요일 변경 (여유 부족)`});
                }else{
                  warnings.push({type:'danger',msg:`${nurse.name}: ${week.cycle}주기에 주휴 배정 불가`});
                }
              }
            }
          }
        }
      }

      // 추천 후 일별 주휴 수 집계
      const juhuPerDay={};
      for(const[nid,list]of Object.entries(assignments)){
        for(const a of list){
          if(!juhuPerDay[a.dk])juhuPerDay[a.dk]=0;
          juhuPerDay[a.dk]++;
        }
      }

      // 배정 정렬 (날짜순)
      for(const nid of Object.keys(assignments)){
        assignments[nid].sort((a,b)=>a.day-b.day);
      }

      return {assignments,warnings,juhuPerDay};
    },

    applyRecommendedJuhu(){
      if(!this.juhuRecommendation)return;
      const{assignments}=this.juhuRecommendation;
      this._pushUndo(); // 대량 변경 — Ctrl+Z로 되돌릴 수 있어야 함
      let count=0;
      for(const[nid,list]of Object.entries(assignments)){
        for(const a of list){
          if(a.existing)continue;
          if(!this.prevSchedule[nid])this.prevSchedule[nid]={};
          this.prevSchedule[nid][a.dk]='주';
          count++;
        }
      }
      if(count===0){this.toast('이미 모든 주휴가 반영되어 있습니다','info');return}
      // 적용 후 자동 재분석 + 사전입력 탭으로 이동
      this.runAnalysis();
      this.toast(`${count}건의 주휴가 사전입력에 적용되었습니다. 분석이 자동으로 갱신됩니다.`,'info',5000);
    },

    getSlackClass(slack){
      if(slack>=4)return'slack-good';
      if(slack>=3)return'slack-ok';
      if(slack>=2)return'slack-tight';
      if(slack>=1)return'slack-warn';
      return'slack-danger';
    },
    getSlackLabel(slack){
      if(slack>=4)return'여유';
      if(slack>=3)return'양호';
      if(slack>=2)return'적정';
      if(slack>=1)return'빡빡';
      return'부족';
    },

  };
};
