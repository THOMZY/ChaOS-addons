// Free-play state: no wallet, no duel timers.
export class SandboxManager {
  constructor() {
    this.accepting = true;
    this._players = new Map();
    this._stage = null;
    this._nextSlot = 0;
  }

  quiesce() {
    this.accepting = false;
  }
  clear() {
    this._players.clear();
    this._stage = null;
  }

  join(player, char, defFile) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    if (this._players.has(player.accountId)) {
      return { ok: true, slot: this._players.get(player.accountId).slot, rejoin: true };
    }
    const slot = this._nextSlot++;
    this._players.set(player.accountId, {
      slot,
      userId: player.userId,
      pseudo: player.pseudo,
      color: player.color,
      char: (char || '').slice(0, 64) || null,
      defFile: (defFile || '').slice(0, 128) || null,
      lastX: null,
      lastY: null,
      lastState: null,
    });
    return { ok: true, slot };
  }

  leave(accountId) {
    const p = this._players.get(accountId);
    if (!p) return { ok: false };
    this._players.delete(accountId);
    return { ok: true, slot: p.slot };
  }

  updatePos(accountId, x, y, stateId) {
    if (!this.accepting) return;
    const p = this._players.get(accountId);
    if (!p) return;
    if (typeof x === 'number' && isFinite(x)) p.lastX = x;
    if (typeof y === 'number' && isFinite(y)) p.lastY = y;
    if (typeof stateId === 'string') p.lastState = stateId;
  }

  changeChar(accountId, char, defFile) {
    if (!this.accepting) return { ok: false, error: 'unavailable' };
    const p = this._players.get(accountId);
    if (!p) return { ok: false };
    p.char = (char || '').slice(0, 64) || null;
    p.defFile = (defFile || '').slice(0, 128) || null;
    return { ok: true, slot: p.slot };
  }

  changeStage(stage) {
    if (!this.accepting) return;
    if (stage && typeof stage.folder === 'string') {
      this._stage = {
        folder: stage.folder.slice(0, 100),
        defFile: typeof stage.defFile === 'string' ? stage.defFile.slice(0, 128) : '',
        sffFile: typeof stage.sffFile === 'string' ? stage.sffFile.slice(0, 128) : '',
      };
    } else {
      this._stage = null;
    }
  }

  getState() {
    return {
      players: [...this._players.values()].map((p) => ({ ...p })),
      stage: this._stage ? { ...this._stage } : null,
    };
  }

  getCount() {
    return this._players.size;
  }
  hasPlayer(accountId) {
    return this._players.has(accountId);
  }
  getPlayer(accountId) {
    return this._players.get(accountId);
  }
}
