/* ────────────────────────────────────────────────────────────────────────────
 * 드래그 다중 선택 모듈 — 사전입력 셀 그리드 multi-select
 *
 * 사용: app() 반환 객체에 `...DragSelectModule()` 로 스프레드.
 * 의존: this._isDragging, _dragStart, _dragCells, prevSchedule, nurses,
 *       this.shiftEdit, dayKey(), openPrevEdit(), _pushUndo(), _checkViolations()
 * ─────────────────────────────────────────────────────────────────────────── */
window.DragSelectModule = function() {
  return {
    onCellMouseDown(nurse, day, event) {
      if (event.button !== 0) return;
      this._isDragging = true;
      this._dragStart = { nid: nurse.id, day };
      this._dragCells = [{ nid: nurse.id, day, dk: this.dayKey(day) }];
    },
    onCellMouseOver(nurse, day) {
      if (!this._isDragging) return;
      const dk = this.dayKey(day);
      if (!this._dragCells.some(c => c.nid === nurse.id && c.dk === dk)) {
        this._dragCells.push({ nid: nurse.id, day, dk });
      }
    },
    onCellMouseUp() {
      if (!this._isDragging) return;
      this._isDragging = false;
      if (this._dragCells.length > 1) {
        this.shiftEdit = {
          open: true,
          nurse: this._dragCells[0],
          day: this._dragCells[0].day,
          dateLabel: `${this._dragCells.length}셀 선택`,
          mode: 'prev_multi',
        };
      } else if (this._dragCells.length === 1) {
        const c = this._dragCells[0];
        const nurse = this.nurses.find(n => n.id === c.nid);
        if (nurse) this.openPrevEdit(nurse, c.day);
      }
      this._dragStart = null;
    },
    isDragSelected(nurseId, day) {
      if (!this._isDragging) return false;
      const dk = this.dayKey(day);
      return this._dragCells.some(c => c.nid === nurseId && c.dk === dk);
    },
    applyMultiShiftEdit(shift) {
      if (shift === '__CLEAR__') {
        this._pushUndo();
        for (const c of this._dragCells) {
          if (this.prevSchedule[c.nid]) delete this.prevSchedule[c.nid][c.dk];
        }
      } else {
        this._pushUndo();
        for (const c of this._dragCells) {
          if (!this.prevSchedule[c.nid]) this.prevSchedule[c.nid] = {};
          this.prevSchedule[c.nid][c.dk] = shift;
        }
      }
      this._dragCells = [];
      this.shiftEdit.open = false;
      this._checkViolations();
    },
  };
};
