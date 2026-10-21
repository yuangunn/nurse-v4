/* ────────────────────────────────────────────────────────────────────────────
 * 프로필 시스템 — 목록/열기/전환/생성/삭제/비밀번호 (프로필 선택 화면)
 *
 * 사용: app() 반환 객체에 `...ProfilesModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.ProfilesModule = function() {
  return {
    // ── 프로필 관리 ──
    async _loadProfiles(){
      try{
        const res=await this.api('GET','/api/profiles');
        this.profiles=res.profiles||[];
        this.hasMasterPassword=res.has_master_password||false;
        this.currentProfile=res.current_profile;
      }catch(e){this.profiles=[];this.hasMasterPassword=false}
    },

    async selectProfile(profile){
      this.profileError='';
      if(profile.has_password||this.hasMasterPassword){
        // 비밀번호 입력 필요 — 이미 입력된 상태에서 호출됨
        if(profile.has_password&&!this.profilePasswordInput){
          this.profileError='비밀번호를 입력해주세요.';return;
        }
      }
      const body={id:profile.id,password:this.profilePasswordInput||''};
      if(this.hasMasterPassword)body.master_password=this.profileMasterInput||'';

      try{
        const res=await this.api('POST','/api/profiles/open',body);
        if(!res.ok){
          if(res.need_master_password){this.profileError='마스터 비밀번호를 입력해주세요.';return}
          this.profileError=res.error||'프로필 열기 실패';return;
        }
        this.currentProfile=profile.id;
        this.profilePasswordInput='';
        this.profileMasterInput='';
        this.profileScreen=false;
        this.profileSwitchModal=false;
        await this._initApp();
      }catch(e){this.profileError=e.message||'서버 오류'}
    },

    async _closeCurrentProfile(){
      if(!this.currentProfile)return;
      try{await this.api('POST','/api/profiles/close')}catch(e){}
    },

    profileSwitchModal:false,
    async switchProfile(){
      this.profilePasswordInput='';
      this.profileMasterInput='';
      this.profileError='';
      await this._loadProfiles();
      this.profileSwitchModal=true;
    },
    async switchToProfile(profile){
      this.profileError='';
      // 만드는 중엔 바꾸지 않는다 — 서버는 앞 병동 DB 를 닫고, 끝난 표는 넣을 병동이 없다
      if(this.generating){this.profileError='근무표를 만드는 중에는 병동을 바꿀 수 없습니다 — 끝나거나 멈춘 뒤에 바꾸세요.';return}
      if(profile.has_password&&!this.profilePasswordInput){
        this.profileError='비밀번호를 입력해주세요.';return;
      }
      const body={id:profile.id,password:this.profilePasswordInput||''};
      if(this.hasMasterPassword)body.master_password=this.profileMasterInput||'';
      try{
        // 지금 병동은 서버가 새 비밀번호를 확인한 뒤에만 닫는다 (api.py open_profile) — 먼저 닫으면 비밀번호가 틀렸을 때
        // 닫힌 병동 자리에 빈 DB 가 생겨 다시 열 때 병동 데이터를 덮었다 (2026-10-21). 틀리면 지금 병동 그대로
        const res=await this.api('POST','/api/profiles/open',body);
        if(!res.ok){this.profileError=res.error||'프로필 열기 실패';return}
        this._saveFullState();this._lsPid=null;   // 지금 병동 작업을 그 병동 보관본에 남긴다 — 새 병동을 복원하기 전엔 쓰지 않는다
        this.currentProfile=profile.id;
        this.profilePasswordInput='';
        this.profileMasterInput='';
        this.profileSwitchModal=false;
        // 프로필별 상태 전부 초기화 — 잠금·메모·공휴일·전월N·undo 스택이 남으면
        // 다른 병동 프로필로 새어 들어가 생성 payload·저장에 섞인다
        this.nurses=[];this.schedule={};this.prevSchedule={};
        this.extendedSchedule={};this.nurseScores={};this.nurseScoreDetails={};
        this.lockedCells={};this.cellNotes={};this.holidays=[];
        this.prevDayReqs={};this.prevMonthNights={};this.relaxedCells={};
        this.solverLogs=[];this._undoStack=[];this._redoStack=[];
        this._resetGridHistory();this._originalSchedule=null;   // 근무표 되돌리기·고른 칸·고친 칸 기준도 (앞 병동 표가 되살아났다)
        // 생성·진단·분석 결과와 고른 사람도 — B 서랍에 A 의 이름·메모가 남고, '수정안 모두 적용'·주휴 추천이 A 의 것을 B 에 걸었다
        this.statusMessage='';this.statusOk=true;this.diagResult=null;this.fixResult=null;
        this.generationReport=null;this.wishReport=null;this.offTeukgeun=[];this.managerCheck=[];this.vReport=null;
        this.relaxBoosts={};this.fairnessOffsets=null;this.weekendOffsets=null;this.fairnessLedger3m=null;
        this.mipGapPercent=null;this.scheduleStopped=false;this.rdSaved=false;this.rdDoneAt=null;
        this.analysisResult=null;this.analysisWarnings=[];this.juhuRecommendation=null;this._lastAnalysisKey='';
        this.readjustPins={};this.readjustChanged={};this.readjustSummary='';this.closeCompare();this.multiSolveResults=[];
        this.scheduleViolations=[];this._feasSeq++;this.feas=null;this.staffingAlerts=null;   // 날아오는 중인 신호등 응답도 버린다
        this.selectedNurseMap={};this._rosterAnchor=null;
        await this._initApp();
      }catch(e){this.profileError=e.message||'서버 오류'}
    },

    openProfileCreate(){
      this.profileCreateModal={open:true,id:'',name:'',password:'',passwordConfirm:''};
    },

    async createProfile(){
      const m=this.profileCreateModal;
      if(!m.id.trim()||!m.name.trim()){this.toast('ID와 이름을 입력해주세요.','error');return}
      if(m.password&&m.password!==m.passwordConfirm){this.toast('비밀번호가 일치하지 않습니다.','error');return}
      try{
        await this.api('POST','/api/profiles/create',{id:m.id.trim(),name:m.name.trim(),password:m.password});
        m.open=false;
        await this._loadProfiles();
        this.toast(`프로필 "${m.name}" 생성 완료`);
      }catch(e){this.toast(e.message||'생성 실패','error')}
    },

    async confirmDeleteProfile(profileId){
      const profile=this.profiles.find(p=>p.id===profileId);
      if(!profile)return;
      const name=profile.name;
      let input;
      try{
        input=window.prompt(`이 프로필과 모든 데이터가 영구 삭제됩니다.\n삭제하려면 "${name}"을(를) 입력하세요:`);
      }catch(e){
        // Electron 렌더러는 prompt 미지원 — confirm으로 대체 (이름 입력 생략)
        input=confirm(`프로필 "${name}"과(와) 모든 데이터가 영구 삭제됩니다.\n정말 삭제하시겠습니까?`)?name:null;
      }
      if(input===null)return; // 취소
      if(input.trim()!==name){this.toast('프로필 이름이 일치하지 않습니다.','error');return}
      try{
        await this.api('DELETE',`/api/profiles/${profileId}`);
        try{localStorage.removeItem('ns_full_state:'+profileId)}catch(e){}   // 그 병동 자동 보관본도 — 같은 ID 로 다시 만들면 지운 병동 사전입력이 깔린다
        await this._loadProfiles();
        this.toast('프로필 삭제 완료');
      }catch(e){this.toast(e.message||'삭제 실패','error')}
    },

    openChangePw(profileId){
      this.profileChangePwModal={open:true,id:profileId,oldPw:'',newPw:'',newPwConfirm:''};
    },

    async changeProfilePassword(){
      const m=this.profileChangePwModal;
      if(!m.newPw){this.toast('새 비밀번호를 입력해주세요.','error');return}
      if(m.newPw!==m.newPwConfirm){this.toast('새 비밀번호가 일치하지 않습니다.','error');return}
      try{
        await this.api('POST','/api/profiles/change-password',{id:m.id,old_password:m.oldPw,new_password:m.newPw});
        m.open=false;
        this.toast('비밀번호 변경 완료');
      }catch(e){this.toast(e.message||'변경 실패','error')}
    },

  };
};
