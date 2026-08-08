/* ────────────────────────────────────────────────────────────────────────────
 * 어싸인 탭 — 근무표 기반 병실 자동 배정 (assign-core.js 사용)
 *
 * 사용: app() 반환 객체에 `...AssignModule()` 스프레드.
 * 설정(방 구성·원칙)과 수동 오버라이드는 localStorage에 프로필별 저장.
 * ─────────────────────────────────────────────────────────────────────────── */
window.AssignModule = function () {
  const ROOM_CAP = {
    1001: 5, 1002: 5, 1003: 5, 1004: 5, 1005: 5, 1006: 5, 1014: 5,
    1007: 2, 1008: 2, 1010: 2, 1011: 2, 1012: 2, 1009: 1,
  };
  const DEFAULT_SCHEMES = {
    5: { 차지: ['1012', '1014'], A: ['1001', '1002'], B: ['1003', '1004'], C: ['1005', '1010', '1011'], D: ['1006', '1007', '1008', '1009'] },
    4: { 차지: ['1001', '1014'], A: ['1002', '1003', '1012'], B: ['1004', '1005', '1011'], C: ['1006', '1007', '1008', '1009', '1010'] },
    3: { 차지: ['1001', '1012', '1014'], A: ['1002', '1003', '1004', '1011'], B: ['1005', '1006', '1007', '1008', '1009', '1010'] },
    2: { 차지: [], A: [] }, // 2인: 환자 수에 따라 이전 근무 차지가 수동 분배
  };
  const PERIOD_STYLE = {
    D: { bg: '#d9e9ff', color: '#1e40af', dark: 'rgba(59,130,246,0.18)', darkColor: '#93c5fd' },
    E: { bg: '#d6f5e3', color: '#166534', dark: 'rgba(34,197,94,0.18)', darkColor: '#86efac' },
    N: { bg: '#ffe6c7', color: '#9a4b00', dark: 'rgba(245,158,11,0.18)', darkColor: '#fcd34d' },
  };

  return {
    assignData: null,          // AssignCore.compute 결과
    assignRules: { keepSameShift: true, keepAcrossShift: true, keepAfterOff: true, bounceAfterOff: false },
    assignSchemes: JSON.parse(JSON.stringify(DEFAULT_SCHEMES)),
    assignOverrides: {},       // {dk:{P:{nid:label}}}
    assignSource: 'auto',      // auto | schedule | prev
    assignSeedInfo: '',        // 전월 연속성 이월 안내
    assignCfgOpen: false,
    assignSelectedDay: null,   // dk (일별 상세)
    assignPick: { open: false, nid: '', dk: '', period: '', current: '' },
    _assignCfgLoaded: false,
    _assignOvLoadedKey: '',

    // 주의: 모듈 스프레드(...)는 getter를 즉시 평가하므로 여기선 메서드만 사용
    assignDays() { return this.scheduleDays.filter(d => !this.isOverflow(d)) },
    assignScheduleSrc() {
      if (this.assignSource === 'schedule') return this.schedule;
      if (this.assignSource === 'prev') return this.prevSchedule;
      return Object.keys(this.schedule || {}).length ? this.schedule : this.prevSchedule;
    },

    _assignCfgKey() { return `ns_assign_cfg_${this.currentProfile || 'default'}` },
    _assignOvKey() { return `ns_assign_ov_${this.currentProfile || 'default'}_${this.year}-${this.month}` },
    _assignStateKey(y, m) { return `ns_assign_state_${this.currentProfile || 'default'}_${y}-${m}` },

    // ── 전월 연속성 이월 — 월별 '마지막으로 본 방' 상태 저장/시드 ──
    _assignSaveState() {
      const byNurse = this.assignData?.byNurse || {};
      const nurses = {};
      for (const nid in byNurse) {
        let best = null;
        for (const dk in byNurse[nid]) {
          const v = byNurse[nid][dk];
          if (v.label && (!best || dk > best.dk)) best = { dk, label: v.label, period: v.period };
        }
        if (best) nurses[nid] = { label: best.label, period: best.period, iso: best.dk };
      }
      if (!Object.keys(nurses).length) return; // 빈 결과로 기존 상태를 덮어쓰지 않음
      try { localStorage.setItem(this._assignStateKey(this.year, this.month), JSON.stringify({ nurses })) } catch (e) { }
    },
    _assignSeed(firstDk) {
      const py = this.month === 1 ? this.year - 1 : this.year;
      const pm = this.month === 1 ? 12 : this.month - 1;
      let st = null;
      try { st = JSON.parse(localStorage.getItem(this._assignStateKey(py, pm)) || 'null') } catch (e) { }
      if (!st || !st.nurses) { this.assignSeedInfo = ''; return null; }
      const firstCur = `${this.year}-${String(this.month).padStart(2, '0')}-01`;
      const day0 = Date.parse(firstDk + 'T00:00:00Z');
      const seed = {}; let n = 0;
      for (const nid in st.nurses) {
        const s = st.nurses[nid];
        if (!s || !s.label || !s.iso || s.iso >= firstCur) continue; // 당월 날짜는 현재 계산이 직접 다룸
        const idx = Math.round((Date.parse(s.iso + 'T00:00:00Z') - day0) / 86400000);
        seed[nid] = { label: s.label, period: s.period, idx }; n++;
      }
      this.assignSeedInfo = n ? `↩ 전월(${py}-${pm}) 어싸인 ${n}명 연속성 자동 이월` : '';
      return n ? seed : null;
    },

    assignLoadCfg() {
      if (this._assignCfgLoaded) return;
      this._assignCfgLoaded = true;
      try {
        const cfg = JSON.parse(localStorage.getItem(this._assignCfgKey()) || 'null');
        if (cfg) { this.assignRules = { ...this.assignRules, ...cfg.rules }; this.assignSchemes = cfg.schemes || this.assignSchemes }
      } catch (e) { }
    },
    assignSaveCfg() { localStorage.setItem(this._assignCfgKey(), JSON.stringify({ rules: this.assignRules, schemes: this.assignSchemes })) },
    assignSaveOv() { localStorage.setItem(this._assignOvKey(), JSON.stringify(this.assignOverrides)) },

    // x-effect에서 호출 — 내부에서 읽는 반응형 상태가 바뀌면 자동 재실행
    assignRecompute() {
      this.assignLoadCfg();
      // 월/프로필 바뀔 때만 오버라이드 로드 — 매번 새 객체로 교체하면 x-effect 무한 루프
      const ovKey = this._assignOvKey();
      if (this._assignOvLoadedKey !== ovKey) {
        this._assignOvLoadedKey = ovKey;
        try { this.assignOverrides = JSON.parse(localStorage.getItem(ovKey) || '{}') } catch (e) { this.assignOverrides = {} }
      }
      const nurses = this.nurses.map(n => ({
        id: n.id, seniority: n.seniority,
        // 시간대별 차지 자격 — DC만 가능한 간호사가 N 차지로 뽑히지 않게
        chargeCapable: {
          D: (n.capable_shifts || []).includes('DC'),
          E: (n.capable_shifts || []).includes('EC'),
          N: (n.capable_shifts || []).includes('NC'),
        },
      }));
      const dateKeys = this.scheduleDays.map(d => this.dayKey(d)); // 이월일 포함 → 월초 연속성
      this.assignData = window.AssignCore.compute(nurses, this.assignScheduleSrc(), dateKeys, {
        rules: this.assignRules, overrides: this.assignOverrides,
        seed: this._assignSeed(dateKeys[0]),
        // 연속성은 라벨이 아니라 실제 병실 기준 — 인원이 바뀌어 방 구성이 달라져도
        // 보던 병실을 따라간다 (방 구성은 인원수·라벨로만 정해지므로 날짜 무관)
        roomsFor: (P, cnt, label) =>
          (this.assignSchemes[Math.min(Math.max(cnt, 2), 5)] || {})[label] || [],
      });
      this._assignSaveState();
      if (!this.assignSelectedDay || !dateKeys.includes(this.assignSelectedDay)) {
        const first = this.assignDays()[0];
        this.assignSelectedDay = first ? this.dayKey(first) : null;
      }
    },

    assignCell(nid, day) {
      const info = this.assignData?.byNurse?.[nid]?.[this.dayKey(day)];
      if (!info) return null;
      return {
        label: info.label, period: info.period,
        short: info.label === '차지' ? '차' : (info.label || '—'),
        isOverridden: !!this.assignOverrides[this.dayKey(day)]?.[info.period]?.[nid],
      };
    },
    assignCellStyle(info) {
      if (!info) return '';
      const s = PERIOD_STYLE[info.period];
      return this.darkMode ? `background:${s.dark};color:${s.darkColor}` : `background:${s.bg};color:${s.color}`;
    },

    // 일별 상세 — 시간대별 [{label, nurse, rooms}] + 헬퍼
    assignDayDetail(dk) {
      const day = this.assignData?.byDay?.[dk];
      if (!day) return [];
      const out = [];
      for (const P of ['D', 'E', 'N']) {
        if (!day[P]) continue;
        const cnt = Object.keys(day[P].labels).length + day[P].extra.length;
        const scheme = this.assignSchemes[Math.min(Math.max(cnt, 2), 5)] || {};
        const rows = Object.entries(day[P].labels).map(([label, nid]) => ({
          label, nurse: this.nurses.find(n => n.id === nid)?.name || nid,
          rooms: this.assignRoomsStr(scheme[label]),
        }));
        const extra = day[P].extra.map(nid => this.nurses.find(n => n.id === nid)?.name || nid);
        out.push({ period: P, count: cnt, rows, extra });
      }
      return out;
    },
    assignRoomsStr(rooms) {
      if (!rooms || !rooms.length) return '(수동 분배)';
      return rooms.map(r => `${r}호(${ROOM_CAP[r] || '?'})`).join(' ');
    },

    // ── 방 구성 편집 ──
    assignSchemeStr(cnt, label) { return (this.assignSchemes[cnt][label] || []).join(', ') },
    assignSetScheme(cnt, label, str) {
      this.assignSchemes[cnt][label] = str.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
      this.assignSaveCfg(); this.assignRecompute();
    },
    assignResetSchemes() {
      this.assignSchemes = JSON.parse(JSON.stringify(DEFAULT_SCHEMES));
      this.assignSaveCfg(); this.assignRecompute();
      this.toast('방 구성을 기본값으로 되돌렸습니다', 'info');
    },
    assignRuleChanged(which) {
      // 원칙3(오프 복귀 유지)·원칙4(튕기기)는 반대 개념 — 하나를 켜면 다른 쪽 자동 해제
      if (which === 'keepAfterOff' && this.assignRules.keepAfterOff) this.assignRules.bounceAfterOff = false;
      if (which === 'bounceAfterOff' && this.assignRules.bounceAfterOff) this.assignRules.keepAfterOff = false;
      this.assignSaveCfg(); this.assignRecompute();
    },

    // ── 수동 오버라이드 (셀 클릭 → 라벨 선택, 기존 보유자와 스왑) ──
    assignPickOpen(nid, day) {
      const dk = this.dayKey(day);
      const info = this.assignData?.byNurse?.[nid]?.[dk];
      if (!info) return;
      this.assignPick = { open: true, nid, dk, period: info.period, current: info.label || '' };
    },
    assignPickLabels() {
      const day = this.assignData?.byDay?.[this.assignPick.dk];
      return day?.[this.assignPick.period] ? Object.keys(day[this.assignPick.period].labels) : [];
    },
    assignPickChoose(label) {
      const { nid, dk, period, current } = this.assignPick;
      const ov = (this.assignOverrides[dk] = this.assignOverrides[dk] || {});
      const pv = (ov[period] = ov[period] || {});
      if (label === null) { // 자동으로 되돌리기
        delete pv[nid];
      } else {
        const holder = Object.entries(this.assignData.byDay[dk][period].labels).find(([l, id]) => l === label)?.[1];
        if (holder && holder !== nid && current) pv[holder] = current; // 스왑
        pv[nid] = label;
      }
      this.assignPick.open = false;
      this.assignSaveOv(); this.assignRecompute();
    },
    assignResetOv() {
      this.assignOverrides = {};
      this.assignSaveOv(); this.assignRecompute();
      this.toast('수동 조정을 모두 초기화했습니다', 'info');
    },

    // ── TSV 내보내기 (Excel 붙여넣기용) ──
    assignCopyTsv() {
      const lines = ['날짜\t시간대\t어싸인\t간호사\t병실'];
      for (const d of this.assignDays()) {
        const dk = this.dayKey(d);
        for (const g of this.assignDayDetail(dk)) {
          for (const r of g.rows) lines.push(`${dk}\t${g.period}\t${r.label}\t${r.nurse}\t${r.rooms}`);
          if (g.extra.length) lines.push(`${dk}\t${g.period}\t헬퍼\t${g.extra.join(', ')}\t`);
        }
      }
      navigator.clipboard.writeText(lines.join('\n'))
        .then(() => this.toast('어싸인표를 클립보드에 복사했습니다 (Excel 붙여넣기)', 'info'))
        .catch(() => this.toast('복사 실패', 'error'));
    },
  };
};
