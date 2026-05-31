/* ────────────────────────────────────────────────────────────────────────────
 * 개발자 모드 — 버전 클릭 트리거·DB 정보/다운로드·시드 재생성·마스터 비밀번호
 *
 * 사용: app() 반환 객체에 `...DevToolsModule()` 로 스프레드. 모든 메서드는 this.* 사용.
 * ─────────────────────────────────────────────────────────────────────────── */
window.DevToolsModule = function() {
  return {
    // ── 개발자 모드 이스터에그 ──
    trackVersionClick(){
      const now=Date.now();
      this._versionClickTimestamps.push(now);
      this._versionClickTimestamps=this._versionClickTimestamps.filter(t=>now-t<5000);
      if(this._versionClickTimestamps.length>=5){
        if(this._devModeUnlocked){
          // 이미 활성화 → 해제
          this._devModeUnlocked=false;
          localStorage.removeItem('devMode');
          this.toast('개발자 권한이 해제되었습니다','info');
        }else{
          this._devModeUnlocked=true;
          localStorage.setItem('devMode','true');
          this.toast('개발자 모드가 활성화되었습니다!','info');
        }
        this._versionClickTimestamps=[];
      }
    },

    async loadDevDbInfo(){
      try{
        const res=await this.api('GET','/api/dev/info');
        this.devDbInfo=res;
      }catch(e){this.devDbInfo=null}
    },

    async devResetProfilePassword(profileId){
      const name=this.profiles.find(p=>p.id===profileId)?.name||profileId;
      if(!confirm(`"${name}" 프로필의 비밀번호를 초기화하시겠습니까?`))return;
      try{
        await this.api('POST','/api/profiles/change-password',{id:profileId,old_password:'',new_password:'',force_reset:true});
        this.toast(`${name} 비밀번호 초기화 완료`);
        await this._loadProfiles();
      }catch(e){this.toast(e.message||'초기화 실패','error')}
    },

    devClearLocalStorage(){
      if(!confirm('브라우저 로컬 데이터를 모두 삭제하시겠습니까?'))return;
      localStorage.clear();
      this.toast('localStorage 삭제 완료. 새로고침합니다.');
      setTimeout(()=>location.reload(),1000);
    },

    async devResetSeedData(){
      if(!confirm('현재 프로필의 간호사를 예시 데이터(18명)로 초기화하시겠습니까?\n기존 간호사 데이터가 삭제됩니다.'))return;
      try{
        await this.api('POST','/api/dev/reset-seed');
        await this.loadNurses();
        this.toast('예시 데이터 초기화 완료');
      }catch(e){this.toast(e.message||'초기화 실패','error')}
    },

    async devDownloadDb(){
      try{
        const res=await fetch('/api/dev/download-db');
        const blob=await res.blob();
        const a=document.createElement('a');
        a.href=URL.createObjectURL(blob);
        a.download=`${this.currentProfile||'nurse'}_backup.db`;
        a.click();URL.revokeObjectURL(a.href);
        this.toast('DB 백업 다운로드 완료');
      }catch(e){this.toast('다운로드 실패','error')}
    },

    async setDevMasterPassword(){
      if(!this.devMasterPw){this.toast('비밀번호를 입력해주세요.','error');return}
      if(this.devMasterPw!==this.devMasterPwConfirm){this.toast('비밀번호가 일치하지 않습니다.','error');return}
      try{
        await this.api('POST','/api/profiles/master-password',{action:'set',password:this.devMasterPw});
        this.hasMasterPassword=true;
        this.devMasterPw='';this.devMasterPwConfirm='';
        this.toast('마스터 비밀번호 설정 완료');
      }catch(e){this.toast(e.message||'설정 실패','error')}
    },

    devRemovePwInput:'',
    devRemovePwShow:false,
    async removeDevMasterPassword(){
      if(!this.devRemovePwInput){this.toast('현재 마스터 비밀번호를 입력해주세요','error');return}
      try{
        await this.api('POST','/api/profiles/master-password',{action:'remove',current_password:this.devRemovePwInput});
        this.hasMasterPassword=false;
        this.devRemovePwInput='';
        this.devRemovePwShow=false;
        this.toast('마스터 비밀번호 제거 완료');
      }catch(e){
        let msg='제거 실패';
        try{const d=JSON.parse(e.message);msg=d.detail||msg}catch(_){}
        this.toast(msg,'error');
      }
    },

  };
};
