import { createGameScope } from '/core/js/games/game-scope.js';
import { el } from '/core/js/games/ui.js';
import { t, getLocale } from '/core/js/i18n.js';

const owners = new WeakMap();

const BOARD_WIDTH = 554;
const BOARD_HEIGHT = 464;

export function createPeggleUi({ getContainer, emitScore, emitForfeit }) {
  let engine = null;
  let round = null, bodyOwned = null, disposed = false;
  const owner = {};

  function stop() {
    round?.stop(); round = null;
    const previous = engine; engine = null;
    try { previous?.destroy(); }
    finally {
      if (bodyOwned && owners.get(bodyOwned) === owner) { restoreBody(bodyOwned); owners.delete(bodyOwned); }
      bodyOwned = null;
    }
  }
  function claim(body) {
    round = createGameScope(); bodyOwned = body; owners.set(body, owner);
    return round;
  }

  function restoreBody(body) {
    Object.assign(body.style, {
      padding: '', overflow: '', display: '', alignItems: '', justifyContent: '',
    });
  }

  function showWaiting(gameId, score = null) {
    const body = disposed ? null : getContainer();
    if (!body) return;
    stop();
    claim(body);
    body.replaceChildren();
    restoreBody(body);
    const children = [];
    if (score != null) {
      children.push(el('div', { class: 'peggle-waiting-score' },
        `🎱 ${t('games.peggle.score')}: ${score.toLocaleString(getLocale())} pts`));
    }
    children.push(el('div', { class: 'peggle-waiting-text' }, t('games.peggle.waiting')));
    const waiting = el('div', { class: 'peggle-waiting', 'data-game-id': gameId }, ...children);
    // A table window has its own forfeit action; only the historical lobby passes one.
    if (emitForfeit) waiting.appendChild(createForfeitButton(gameId));
    body.appendChild(waiting);
  }

  function createForfeitButton(gameId) {
    const button = el('button', { class: 'btn small peggle-forfeit-btn', type: 'button' }, t('games.forfeit'));
    round.on(button, 'click', () => {
      if (owners.get(bodyOwned) !== owner) return;
      button.disabled = true;
      button.textContent = t('games.forfeitPending');
      stop();
      emitForfeit?.(gameId);
    });
    return button;
  }

  function start(data) {
    stop();
    const body = disposed ? null : getContainer();
    if (!body) return false;
    const Engine = globalThis.PeggleEngine;
    if (typeof Engine !== 'function') return false;
    const view = claim(body);
    const active = () => view.active && owners.get(body) === owner;

    body.replaceChildren();
    Object.assign(body.style, {
      padding: '0', overflow: 'hidden', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    });

    const stage = el('div', { class: 'peggle-stage' });
    const canvas = document.createElement('canvas');
    // Keep the fixed logical 554×464 board but render it at high DPI. The old
    // 1×/pixelated scaling made the addon artwork and rotated bricks jagged.
    const renderScale = Math.min(3, Math.max(2, globalThis.devicePixelRatio || 1));
    canvas.width = Math.round(BOARD_WIDTH * renderScale);
    canvas.height = Math.round(BOARD_HEIGHT * renderScale);
    canvas.className = 'peggle-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', t('games.peggle.boardLabel'));
    stage.appendChild(canvas);
    const angle = el('input', { type: 'range', min: '3', max: '177', step: '1', value: '126', 'aria-label': t('games.peggle.angle'), class: 'peggle-angle' });
    const fire = el('button', { type: 'button', class: 'btn', 'data-game-focus': 'peggle:fire' }, t('games.peggle.fire'));
    const status = el('div', { 'data-game-status': '', class: 'peggle-controls-status' });
    const controls = el('div', { class: 'peggle-controls' }, angle, fire, status);
    stage.appendChild(controls);
    const update = current => {
      if (!active()) return;
      angle.value = String(Math.round(current.aimAngle * 180 / Math.PI));
      angle.setAttribute('aria-valuetext', t('games.peggle.degrees', { value: angle.value }));
      angle.setAttribute('aria-disabled', String(current.state !== 'aim'));
      fire.setAttribute('aria-disabled', String(current.state !== 'aim'));
      const message = t('games.peggle.status', {
        score: current.score,
        balls: current.balls,
        state: t(current.state === 'aim' ? 'games.peggle.ready' : 'games.peggle.shooting'),
      });
      if (status.textContent !== message) status.textContent = message;
    };
    view.on(angle, 'input', () => { engine?.aimAt(Number(angle.value)); if (engine) update(engine); });
    view.on(fire, 'click', () => engine?.shoot());
    if (emitForfeit) stage.appendChild(createForfeitButton(data.gameId));
    body.appendChild(stage);

    const fitCanvas = () => {
      if (!active()) return;
      const scale = Math.min(
        (body.clientWidth || BOARD_WIDTH) / BOARD_WIDTH,
        Math.max(1, (body.clientHeight || BOARD_HEIGHT) - 64) / BOARD_HEIGHT,
      );
      canvas.style.width = `${Math.round(scale * BOARD_WIDTH)}px`;
      canvas.style.height = `${Math.round(scale * BOARD_HEIGHT)}px`;
    };
    fitCanvas();
    view.observe(new ResizeObserver(fitCanvas)).observe(body);

    try {
      const created = new Engine(canvas, data.pegs, {
      soundBase: '/peggle-sounds',
      artBase: '/peggle-images',
      levelId: data.levelId,
      levelName: data.levelName,
      translate: t,
      locale: getLocale(),
      targetScore: data.targetScore ?? null,
      balls: data.balls ?? 10,
      onControlState: update,
      onGameOver: (score) => {
        if (!active()) return;
        emitScore(data.gameId, score);
        if (active()) showWaiting(data.gameId, score);
      },
      });
      if (active()) { engine = created; update(created); } else created.destroy();
    } catch (error) { stop(); throw error; }
    return true;
  }

  function ensureWaiting(gameId) {
    const body = disposed ? null : getContainer();
    if (body && !body.querySelector('.peggle-waiting')) showWaiting(gameId);
  }

  return { start, stop, ensureWaiting, dispose() { if (disposed) return; disposed = true; stop(); } };
}
