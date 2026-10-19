/* ────────────────────────────────────────────────────────────────────────────
 * 표 칸 선택 모듈 — 사전입력·근무표 공용 (2026-10-19)
 *
 * 칸을 끌면 네모 범위가 잡히고(Shift+클릭·Shift+방향키로 넓히기), 이름 칸을 끌면 여러 사람 줄을 통째로 고른다.
 * 고른 범위에 근무 키(D E N V O …)·Del·Enter(팝업)·Ctrl+C/X/V(엑셀과 칸 묶음 주고받기)·Ctrl+Z 가 걸린다.
 * 근무표 칸은 비울 수 없다 — 팝업에도 '지우기'가 없고, 빈칸은 만든 값이 다시 보인다 (Del·빈칸 붙여넣기는 건너뜀).
 *
 * 사용: app() 반환 객체에 `...DragSelectModule()` 로 스프레드.
 * 의존: this._sel, _isDragging, _dragCells, nurses, rdPhoneNurses, scheduleDays, prevSchedule, schedule, shiftEdit,
 *       dayKey(), isNurseInactive(), getPrevShift(), displayShift(), _normalizeShiftCode(), _pushUndo(), undo(), redo(),
 *       _checkViolations(), checkScheduleViolations(), openPrevEdit(), openShiftEdit(), rdPlacePopup(), toast()
 * ─────────────────────────────────────────────────────────────────────────── */
window.DragSelectModule = function() {
  const CODE_KEYS = { D: 'D', E: 'E', N: 'N', V: 'V', O: 'OF', W: '주' };
  // 쌍자음 = Shift: ㄲ 경가 · ㅉ 조가 · ㅆ 산전 (rdPopupKey 와 같은 표)
  const HANGUL_KEYS = { 'ㅈ': '주', 'ㅂ': '병', 'ㅃ': '법', 'ㅅ': '생', 'ㅌ': '특', 'ㄱ': '공', 'ㄲ': '경가', 'ㅉ': '조가', 'ㅆ': '산전' };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  return {
    // ── 범위 ──
    _gridRows(tab) { return tab === 'schedule' ? (this.rdPhoneNurses || []) : (this.nurses || []); },
    _selRect() {
      const s = this._sel; if (!s) return null;
      return { tab: s.tab, rA: Math.min(s.r0, s.r1), rB: Math.max(s.r0, s.r1), cA: Math.min(s.c0, s.c1), cB: Math.max(s.c0, s.c1) };
    },
    isSel(tab, r, c) { const q = this._selRect(); return !!q && q.tab === tab && r >= q.rA && r <= q.rB && c >= q.cA && c <= q.cB; },
    _selCount() { const q = this._selRect(); return q ? (q.rB - q.rA + 1) * (q.cB - q.cA + 1) : 0; },
    _rectCells(q) {
      const rows = this._gridRows(q.tab), days = this.scheduleDays || [], out = [];
      for (let r = q.rA; r <= q.rB; r++) for (let c = q.cA; c <= q.cB; c++) {
        const nurse = rows[r], day = days[c];
        if (!nurse || !day || this.isNurseInactive(nurse, day)) continue;   // 전입 전·전출 뒤는 칸이 아니다
        out.push({ nurse, day, r, c, nid: nurse.id, dk: this.dayKey(day) });
      }
      return out;
    },
    _setSel(tab, r0, c0, r1 = r0, c1 = c0) {
      this._sel = { tab, r0, c0, r1, c1 };
      if (tab === 'preinput') this._focusedCell = { nIdx: r1, dIdx: c1 };   // 가져오기 창의 '커서에서 붙이기'가 쓴다
    },
    focusCell(nIdx, dIdx) { if (!this._isDragging) this._setSel('preinput', nIdx, dIdx); },
    isFocused(nIdx, dIdx) { const s = this._sel; return !!s && s.tab === 'preinput' && s.r1 === nIdx && s.c1 === dIdx; },
    isDragSelected(nurseId, day) {          // 사전입력 칸 class (g-drag-sel) — 두 칸 이상 고른 범위
      const q = this._selRect(); if (!q || q.tab !== 'preinput' || this._selCount() < 2) return false;
      const r = (this.nurses || []).findIndex(n => n.id === nurseId), c = (this.scheduleDays || []).findIndex(d => this.dayKey(d) === this.dayKey(day));
      return r >= q.rA && r <= q.rB && c >= q.cA && c <= q.cB;
    },

    // ── 마우스 ──
    gridDown(tab, r, c, e) {
      if (e.button !== 0) return;
      if (e.shiftKey && this._sel && this._sel.tab === tab) this._sel = { ...this._sel, r1: r, c1: c };
      else this._setSel(tab, r, c);
      this._isDragging = true; this._dragRows = false; this._dragMoved = false;
    },
    gridDownRow(tab, r, e) {
      if (e.button !== 0 || e.target.closest('button')) return;
      const last = Math.max(0, (this.scheduleDays || []).length - 1);
      if (e.shiftKey && this._sel && this._sel.tab === tab) this._sel = { ...this._sel, c0: 0, c1: last, r1: r };
      else this._setSel(tab, r, 0, r, last);
      this._isDragging = true; this._dragRows = true; this._dragMoved = false;
      e.preventDefault();                     // 이름 글자가 끌려 선택되지 않게
    },
    gridOver(tab, r, c) {
      const s = this._sel;
      if (!this._isDragging || this._dragRows || !s || s.tab !== tab || (s.r1 === r && s.c1 === c)) return;
      this._sel = { ...s, r1: r, c1: c }; this._dragMoved = true;
      if (tab === 'preinput') this._focusedCell = { nIdx: r, dIdx: c };
    },
    gridOverRow(tab, r) {
      const s = this._sel;
      if (!this._isDragging || !this._dragRows || !s || s.tab !== tab || s.r1 === r) return;
      this._sel = { ...s, r1: r }; this._dragMoved = true;
    },
    gridUp() {
      if (!this._isDragging) return;
      this._isDragging = false;
      const q = this._selRect(); if (!q) return;
      if (this._dragRows) {                   // 이름 칸으로 고른 줄 — 팝업 대신 할 수 있는 것을 한 번 알린다
        if (!this._rowSelHinted) {
          this._rowSelHinted = true;
          this.toast(`${q.rB - q.rA + 1}명 줄을 골랐어요 — 근무 키(D·E·N…)로 채우고, Ctrl+V 로 붙여 넣고, Ctrl+C 로 엑셀에 복사합니다`, 'info', 5000);
        }
        return;
      }
      if (this._selCount() > 1) this._openMultiEdit(q);
    },
    // 칸 클릭 — 끌지 않은 한 번 클릭만 팝업을 연다 (Shift+클릭은 범위 넓히기)
    gridClick(e) { return !e.shiftKey && !this._dragMoved; },

    // ── 여러 칸 팝업 ──
    _openMultiEdit(q) {
      const cells = this._rectCells(q);
      if (cells.length < 2) return;
      this._dragCells = cells.map(x => ({ nid: x.nid, day: x.day, dk: x.dk }));
      const end = cells[cells.length - 1];   // 팝업은 범위 오른쪽 끝 옆에 — 첫 칸 옆이면 고른 칸을 가렸다
      this.shiftEdit = { open: true, nurse: this._dragCells[0], day: cells[0].day, dateLabel: `${cells.length}칸 선택`,
                         mode: q.tab === 'schedule' ? 'sched_multi' : 'prev_multi', anchorEnd: { nid: end.nid, dk: end.dk } };
    },
    applyMultiShiftEdit(shift) {
      const tab = this.shiftEdit.mode === 'sched_multi' ? 'schedule' : 'preinput';
      this._gridWrite(tab, this._dragCells.map(c => ({ nid: c.nid, dk: c.dk, code: shift })));
      this._dragCells = [];
      this.shiftEdit.open = false;
    },

    // ── 쓰기 (되돌리기 한 번) ──
    _gridWrite(tab, items) {
      if (tab === 'schedule') items = items.filter(x => x.code !== '__CLEAR__');
      if (!items.length) return 0;
      if (tab === 'schedule') {
        this._schedPush();
        for (const { nid, dk, code } of items) (this.schedule[nid] = this.schedule[nid] || {})[dk] = code;
        this.rdSaved = false;
        if (this.checkScheduleViolations) this.checkScheduleViolations();
      } else {
        this._pushUndo();
        for (const { nid, dk, code } of items) {
          if (code === '__CLEAR__') { if (this.prevSchedule[nid]) delete this.prevSchedule[nid][dk]; }
          else (this.prevSchedule[nid] = this.prevSchedule[nid] || {})[dk] = code;
        }
        this._checkViolations();
      }
      return items.length;
    },
    // 근무표 되돌리기 — 사전입력 스택과 따로 (같이 두면 사전입력 Ctrl+Z 가 만든 근무표까지 되돌렸다)
    _schedPush() {
      this._schedUndo.push(JSON.stringify(this.schedule || {}));
      if (this._schedUndo.length > 40) this._schedUndo.shift();
      this._schedRedo = [];
    },
    schedUndo() {
      if (!this._schedUndo.length) return;
      this._schedRedo.push(JSON.stringify(this.schedule || {}));
      this.schedule = JSON.parse(this._schedUndo.pop());
      this.rdSaved = false;
      if (this.checkScheduleViolations) this.checkScheduleViolations();
    },
    schedRedo() {
      if (!this._schedRedo.length) return;
      this._schedUndo.push(JSON.stringify(this.schedule || {}));
      this.schedule = JSON.parse(this._schedRedo.pop());
      this.rdSaved = false;
      if (this.checkScheduleViolations) this.checkScheduleViolations();
    },

    // ── 키보드 (전역 keydown 이 팝업·입력 칸이 없을 때 넘긴다) ──
    _keyCode(e) {
      const key = (e.key || '').toUpperCase();
      return CODE_KEYS[key] || HANGUL_KEYS[e.key] || ((this.shifts || []).find(s => s.code.toUpperCase() === key) || {}).code || null;
    },
    gridKey(e) {
      const s = this._sel; if (!s) return false;
      const tab = s.tab, rows = this._gridRows(tab), days = this.scheduleDays || [];
      const k = e.key || '', ctrl = e.ctrlKey || e.metaKey;
      if (ctrl) {
        const kl = k.toLowerCase();
        if (kl === 'z' || kl === 'y') {
          const redo = kl === 'y' || e.shiftKey;
          if (tab === 'schedule') { redo ? this.schedRedo() : this.schedUndo(); } else { redo ? this.redo() : this.undo(); }
          e.preventDefault(); return true;
        }
        if (kl === 'a') { this._sel = { tab, r0: 0, c0: 0, r1: rows.length - 1, c1: days.length - 1 }; e.preventDefault(); return true; }
        return false;                         // Ctrl+C·X·V 는 copy·cut·paste 이벤트로
      }
      const arrows = { ArrowRight: [0, 1], ArrowLeft: [0, -1], ArrowDown: [1, 0], ArrowUp: [-1, 0] };
      if (arrows[k]) {
        const [dr, dc] = arrows[k];
        const r = clamp(s.r1 + dr, 0, rows.length - 1), c = clamp(s.c1 + dc, 0, days.length - 1);
        if (e.shiftKey) this._sel = { ...s, r1: r, c1: c }; else this._setSel(tab, r, c);
        if (tab === 'preinput') this._focusedCell = { nIdx: r, dIdx: c };
        this._scrollSelIntoView();
        e.preventDefault(); return true;
      }
      if (k === 'Escape') { this._sel = null; if (tab === 'preinput') this._focusedCell = null; return true; }
      if (k === 'Enter') {
        const q = this._selRect();
        if (this._selCount() > 1) this._openMultiEdit(q);
        else { const nurse = rows[s.r1], day = days[s.c1]; if (nurse && day) (tab === 'schedule' ? this.openShiftEdit(nurse, day) : this.openPrevEdit(nurse, day)); }
        e.preventDefault(); return true;
      }
      if (k === 'Delete' || k === 'Backspace') {
        if (tab === 'schedule') this.toast('근무표 칸은 비울 수 없어요 — 다른 근무를 넣으세요', 'info');
        else this._gridWrite(tab, this._rectCells(this._selRect()).map(x => ({ nid: x.nid, dk: x.dk, code: '__CLEAR__' })));
        e.preventDefault(); return true;
      }
      const code = this._keyCode(e);
      if (code && !e.altKey) {
        this._gridWrite(tab, this._rectCells(this._selRect()).map(x => ({ nid: x.nid, dk: x.dk, code })));
        e.preventDefault(); return true;
      }
      return false;
    },
    _scrollSelIntoView() {
      const s = this._sel; if (!s) return;
      const nurse = this._gridRows(s.tab)[s.r1], day = (this.scheduleDays || [])[s.c1]; if (!nurse || !day) return;
      this.$nextTick(() => {
        const el = [...document.querySelectorAll(`[data-cell="${nurse.id}|${this.dayKey(day)}"]`)].find(x => x.offsetParent);
        if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    },

    // ── 엑셀과 칸 묶음 주고받기 (탭으로 칸, 줄바꿈으로 줄) ──
    _gridClipOk(e) {
      const tab = this.activeTab, t = e && e.target;
      if (!this._sel || this._sel.tab !== tab || (tab !== 'preinput' && tab !== 'schedule')) return false;
      if (this.shiftEdit?.open || this.noteEdit?.open || this.juhuOptionModal?.open || this.pastePrev?.open) return false;
      if (t && (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) || t.isContentEditable)) return false;
      return true;
    },
    _parseTsv(text) {
      let t = String(text || '').replace(/\r\n?/g, '\n');
      if (t.endsWith('\n')) t = t.slice(0, -1);
      if (!t) return [];
      return t.split('\n').map(line => line.split('\t').map(c => (c.length > 1 && c.startsWith('"') && c.endsWith('"')) ? c.slice(1, -1).replace(/""/g, '"') : c));
    },
    _gridTsv(q) {
      const rows = this._gridRows(q.tab), days = this.scheduleDays || [], lines = [];
      for (let r = q.rA; r <= q.rB; r++) {
        const nurse = rows[r]; if (!nurse) continue;
        const vals = [];
        for (let c = q.cA; c <= q.cB; c++) {
          const day = days[c];
          const v = !day || this.isNurseInactive(nurse, day) ? '' : (q.tab === 'schedule' ? this.displayShift(nurse.id, day) : this.getPrevShift(nurse.id, day));
          vals.push(v && v !== '__CLEAR__' ? v : '');
        }
        lines.push(vals.join('\t'));
      }
      return lines.join('\n');
    },
    gridCopy(e, cut) {
      if (!this._gridClipOk(e)) return;
      if (!cut && String(window.getSelection?.() || '')) return;   // 글자를 고른 채 복사면 그 글자를
      const q = this._selRect(), n = this._selCount();
      e.clipboardData.setData('text/plain', this._gridTsv(q));
      e.preventDefault();
      if (cut && q.tab === 'preinput') {
        this._gridWrite('preinput', this._rectCells(q).map(x => ({ nid: x.nid, dk: x.dk, code: '__CLEAR__' })));
        this.toast(`${n}칸을 잘라 냈어요 — 엑셀이나 다른 칸에 붙여 넣으세요 (Ctrl+Z 로 되돌리기)`, 'info');
      } else this.toast(`${n}칸 복사했어요 — 엑셀이나 다른 칸에 붙여 넣으세요`, 'info');
    },
    gridPaste(e) {
      if (!this._gridClipOk(e)) return;
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (!text) return;
      e.preventDefault();
      this.gridPasteText(text);
    },
    // 근무표 칸은 한 근무 — 원티드 '둘 중 하나'(D/E…)·N제외는 받지 않는다
    _pasteCode(tab, raw) {
      const code = this._normalizeShiftCode(String(raw ?? '').trim());   // null = 비움 · undefined = 모르는 표기
      if (code && tab === 'schedule' && this.isFlexWish && this.isFlexWish(code)) return undefined;
      return code;
    },
    // 엑셀처럼: 고른 칸의 왼쪽 위부터 채운다. 한 칸만 복사했고 여러 칸을 골랐으면 고른 칸 모두에
    gridPasteText(text) {
      const q = this._selRect(); if (!q) return;
      const grid = this._parseTsv(text); if (!grid.length) return;
      const rows = this._gridRows(q.tab), days = this.scheduleDays || [];
      const items = [], unknown = new Set(); let skipped = 0, cleared = 0;
      const put = (r, c, raw) => {
        const nurse = rows[r], day = days[c];
        if (!nurse || !day) return;
        if (this.isNurseInactive(nurse, day)) { skipped++; return; }
        const code = this._pasteCode(q.tab, raw);
        if (code === undefined) { if (String(raw).trim()) unknown.add(String(raw).trim()); return; }
        const dk = this.dayKey(day);
        if (code === null) {
          if (q.tab === 'schedule') return;                       // 근무표 칸은 비우지 않는다
          if (this.prevSchedule[nurse.id]?.[dk]) cleared++;
          items.push({ nid: nurse.id, dk, code: '__CLEAR__' }); return;
        }
        items.push({ nid: nurse.id, dk, code });
      };
      let h, w;
      if (grid.length === 1 && grid[0].length === 1 && this._selCount() > 1) {
        h = q.rB - q.rA + 1; w = q.cB - q.cA + 1;
        for (let r = q.rA; r <= q.rB; r++) for (let c = q.cA; c <= q.cB; c++) put(r, c, grid[0][0]);
      } else {
        h = grid.length; w = Math.max(...grid.map(x => x.length));
        grid.forEach((line, i) => line.forEach((raw, j) => put(q.rA + i, q.cA + j, raw)));
      }
      const n = this._gridWrite(q.tab, items);
      this._sel = { tab: q.tab, r0: q.rA, c0: q.cA, r1: clamp(q.rA + h - 1, 0, rows.length - 1), c1: clamp(q.cA + w - 1, 0, days.length - 1) };
      const parts = [`${n - cleared}칸 넣었어요`];
      if (cleared) parts.push(`${cleared}칸 비움`);
      if (unknown.size) parts.push(`모르는 표기 ${[...unknown].slice(0, 3).join(', ')}${unknown.size > 3 ? ' 등' : ''} 건너뜀`);
      if (skipped) parts.push(`전입 전·전출 뒤 ${skipped}칸 건너뜀`);
      if (h > 1 && q.rA + h > rows.length || q.cA + w > days.length) parts.push('표 밖으로 나간 칸은 버렸어요');
      this.toast(parts.join(' · ') + (n ? ' (Ctrl+Z 로 되돌리기)' : ''), n ? 'success' : 'info', 5000);
      return { written: n, cleared, unknown: [...unknown], skipped };
    },
  };
};
