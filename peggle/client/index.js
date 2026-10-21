import { el } from '/core/js/games/ui.js';
import { t, getLocale } from '/core/js/i18n.js';
import { renderUserName } from '/core/js/user-name.js';
import { createGameScope } from '/core/js/games/game-scope.js';
import { loadGameResources } from '/core/js/games/game-resource-loader.js';

// One run per seat and round survives a remount (language change, display
// closed and reopened): the board lives in a detached host the next mount
// adopts, so closing the display can never restart a level for a better score.
const runs = new Map();

function runKey(table, me) {
  return `${table.id}:${table.round}:${me?.userId}`;
}

export function create(context) {
  const scope = createGameScope();
  let current = context;
  const root = el('div', { class: 'table-peggle' });
  const status = el('p', { role: 'status', class: 'table-peggle-status' });
  const scores = el('div', { class: 'table-peggle-scores' });
  const slot = el('div', { class: 'table-peggle-slot' });
  root.append(status, slot, scores);
  context.container.replaceChildren(root);

  const mySeat = () =>
    current.table.players.find((player) => player.userId === current.me?.userId)?.seat;
  const myState = () => current.table.game.players.find((player) => player.seat === mySeat());

  function startRun() {
    const key = runKey(current.table, current.me);
    if (runs.has(key)) return runs.get(key);
    const host = el('div', { class: 'table-peggle-host' });
    const run = { host, ui: null, isLoading: true, hasFailed: false };
    runs.set(key, run);
    const move = (choice) => current.move(choice);
    loadGameResources('peggle')
      .then(({ module }) => {
        if (runs.get(key) !== run) return;
        run.ui = module.createPeggleUi({
          getContainer: () => host,
          emitScore: (_id, score) => move({ type: 'score', score }),
        });
        const game = current.table.game;
        run.ui.start({
          gameId: current.table.id,
          levelId: game.levelId,
          levelName: game.levelName,
          pegs: game.pegs,
          balls: game.balls,
        });
      })
      .catch((error) => {
        console.warn('[tables] Peggle unavailable:', error);
        run.hasFailed = true;
        runs.delete(key);
        if (scope.active) render();
      })
      .finally(() => {
        run.isLoading = false;
      });
    return run;
  }
  function releaseRuns() {
    // Runs of finished rounds (or another table/user) are disposed for good.
    for (const [key, run] of runs) {
      const [id, round] = key.split(':');
      if (id !== current.table.id) continue;
      if (Number(round) !== current.table.round || current.table.phase !== 'running') {
        run.ui?.dispose();
        run.host.remove();
        runs.delete(key);
      }
    }
  }
  function render() {
    releaseRuns();
    const { table } = current;
    const own = myState();
    const isPlaying = table.phase === 'running' && own && !own.isDone && !own.hasForfeited;
    slot.replaceChildren();
    if (isPlaying) {
      const run = startRun();
      slot.append(run.host);
      status.textContent = run.isLoading ? t('games.status.loading') : table.game.levelName;
    } else if (table.phase === 'running') {
      status.textContent = own?.isDone
        ? t('games.peggle.waiting')
        : t('games.tablePeggle.watching');
    } else status.textContent = table.game.levelName;
    scores.replaceChildren(
      ...table.game.players.map((entry) => {
        const player = table.players.find((candidate) => candidate.seat === entry.seat);
        const row = el('div', {
          class: 'table-peggle-score',
          'data-peggle-seat': String(entry.seat),
        });
        if (player) row.append(renderUserName(player));
        const state =
          entry.score !== null
            ? `${entry.score.toLocaleString(getLocale())} pts`
            : entry.hasForfeited
              ? t('games.tablePeggle.forfeited')
              : entry.isDone
                ? '✓'
                : '…';
        row.append(` · ${state}`);
        return row;
      }),
    );
  }
  function update(next) {
    if (!scope.active) return;
    current = next;
    render();
  }
  render();
  return {
    update,
    stop() {
      // Detach, not destroy: the run continues and the next mount adopts it.
      for (const run of runs.values()) if (slot.contains(run.host)) run.host.remove();
      scope.stop();
    },
    status: () => ({ stopped: !scope.active, runs: runs.size }),
  };
}
