/* ────────────────────────────────────────────────────────────────────────────
 * Undo/Redo 모듈 — 사전입력 상태 스택 (40단계 한도)
 *
 * 사용: app() 반환 객체에 `...UndoRedoModule()` 로 스프레드.
 * 의존: this.prevSchedule, prevDayReqs, holidays, lockedCells, cellNotes,
 *       this._undoStack, _redoStack, _maxUndo, this._checkViolations()
 * ─────────────────────────────────────────────────────────────────────────── */
window.UndoRedoModule = function() {
  function snapshot(self) {
    return JSON.stringify({
      ps: self.prevSchedule,
      dr: self.prevDayReqs,
      hd: self.holidays,
      lk: self.lockedCells,
      nt: self.cellNotes,
      pm: self.prevMonthNights,
    });
  }
  function restore(self, state) {
    self.prevSchedule = state.ps;
    self.prevDayReqs  = state.dr;
    self.holidays     = state.hd;
    self.lockedCells  = state.lk || {};
    self.cellNotes    = state.nt || {};
    if (state.pm !== undefined) self.prevMonthNights = state.pm;
  }
  return {
    _pushUndo() {
      this._undoStack.push(snapshot(this));
      if (this._undoStack.length > this._maxUndo) this._undoStack.shift();
      this._redoStack = [];
    },
    undo() {
      if (!this._undoStack.length) return;
      this._redoStack.push(snapshot(this));
      restore(this, JSON.parse(this._undoStack.pop()));
      this._checkViolations();
    },
    redo() {
      if (!this._redoStack.length) return;
      this._undoStack.push(snapshot(this));
      restore(this, JSON.parse(this._redoStack.pop()));
      this._checkViolations();
    },
  };
};
