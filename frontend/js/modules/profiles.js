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
      if(profile.has_password&&!this.profilePasswordInput){
        this.profileError='비밀번호를 입력해주세요.';return;
      }
      const body={id:profile.id,password:this.profilePasswordInput||''};
      if(this.hasMasterPassword)body.master_password=this.profileMasterInput||'';
      try{
        await this._closeCurrentProfile();
        const res=await this.api('POST','/api/profiles/open',body);
        if(!res.ok){this.profileError=res.error||'프로필 열기 실패';return}
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
