export function createWormsHud({
  getState,
  getView,
  createElement,
  renderUserName,
  setSafeHtml,
  translate,
  unlimitedAmmo,
  fuseWeapons,
  isActive = () => true,
  clock = () => Date.now(),
  now = () => performance.now(),
  width = 960,
  height = 480,
}) {
  let isStopped = false,
    revision = 0,
    announcement = null;
  const cancelled = Symbol('retired HUD update');
  function assertCurrent(execution) {
    if (isStopped || revision !== execution.revision || !isActive()) throw cancelled;
  }
  function createNode(execution, ...args) {
    const node = createElement(...args);
    assertCurrent(execution);
    return node;
  }
  function renderName(execution, ...args) {
    const node = renderUserName(...args);
    assertCurrent(execution);
    return node;
  }
  function writeHtml(execution, ...args) {
    setSafeHtml(...args);
    assertCurrent(execution);
  }
  function translateLabel(execution, ...args) {
    const label = translate(...args);
    assertCurrent(execution);
    return label;
  }
  function readClock(execution) {
    const value = clock();
    assertCurrent(execution);
    return value;
  }
  function readNow(execution) {
    const value = now();
    assertCurrent(execution);
    return value;
  }
  function reset() {
    revision++;
    announcement = null;
  }
  function stop() {
    if (isStopped) return;
    isStopped = true;
    reset();
  }
  function status() {
    return { isStopped, hasAnnouncement: announcement !== null };
  }
  function run(action, args) {
    if (isStopped || !isActive()) return;
    const execution = { revision };
    try {
      execution.state = getState();
      assertCurrent(execution);
      execution.view = getView();
      assertCurrent(execution);
      return action(execution, ...args);
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function drawTurnAnnouncement(execution, ctx, now) {
    assertCurrent(execution);
    if (!announcement) return;
    const elapsed = now - announcement.startMs;
    if (elapsed >= 2400) {
      announcement = null;
      return;
    }
    const alpha = elapsed < 1600 ? 1 : 1 - (elapsed - 1600) / 800;
    const cy = height * 0.38;
    ctx.save();
    try {
      ctx.globalAlpha = alpha;
      const pad = 22,
        tw = ctx.measureText(announcement.text).width + pad * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      roundRect(ctx, width / 2 - tw / 2, cy - 18, tw, 34, 8);
      ctx.fill();
      ctx.font = 'bold 16px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = announcement.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      ctx.strokeText(announcement.text, width / 2, cy + 4);
      ctx.fillText(announcement.text, width / 2, cy + 4);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    } finally {
      ctx.restore();
    }
  }

  function updateTimerDisplay(execution) {
    if (!execution.view.timer || execution.state.turnDeadline <= 0) return;
    if (execution.state.isRetreating) {
      const s = Math.max(0, Math.ceil((execution.state.retreatEnd - readClock(execution)) / 1000));
      execution.view.timer.textContent = translateLabel(execution, 'games.worms.retreatTimer', {
        seconds: String(s).padStart(2, '0'),
      });
      execution.view.timer.style.color = '#88ddff';
      return;
    }
    const s = Math.max(0, Math.ceil((execution.state.turnDeadline - readClock(execution)) / 1000));
    execution.view.timer.textContent = `⏱ ${String(s).padStart(2, '0')}s`;
    execution.view.timer.style.color = s <= 5 ? '#ff2222' : s <= 8 ? '#ff8844' : '#ffcc00';
  }

  function updateHUD(execution) {
    if (!execution.view.turnLabel) return;
    const pl = execution.state.players.find((p) => p.userId === execution.state.currentTurn);
    const aw = execution.state.worms.find((w) => w.id === execution.state.activeWormId);
    const rnd = execution.state.round ?? 1;
    if (pl && aw) {
      const nameEl = renderName(execution, pl, { fallbackPseudo: '?' });
      const wormEl = createNode(execution, 'span', { style: { color: '#ccc' } }, aw.name);
      execution.view.turnLabel.replaceChildren(
        `${translateLabel(execution, 'games.worms.turnOf')} `,
        nameEl,
        ' — ',
        wormEl,
      );
      if (execution.state.currentTurn === execution.state.myUserId)
        execution.view.turnLabel.append(
          ' ',
          createNode(
            execution,
            'span',
            { style: { color: '#ff0' } },
            translateLabel(execution, 'games.worms.you'),
          ),
        );
    }
    if (execution.view.wind) {
      const arrow = execution.state.wind > 0 ? '→' : execution.state.wind < 0 ? '←' : '·';
      const str = Math.abs(execution.state.wind);
      const roundLabel = execution.state.isSuddenDeath
        ? `<span style="color:#f44">💀R${rnd}</span>`
        : `<span style="color:#aaa">R${rnd}</span>`;
      writeHtml(
        execution,
        execution.view.wind,
        (str === 0
          ? `💨 ${translateLabel(execution, 'games.worms.calmWind')}`
          : `💨 ${arrow} ${str}`) +
          ' ' +
          roundLabel,
      );
    }
    updateHealthBar(execution);
    updateWeaponBtns(execution);
    updateFuseDisplay(execution);
  }

  function updateHealthBar(execution) {
    if (!execution.view.health) return;
    execution.view.health.replaceChildren();
    for (const p of execution.state.players) {
      const mine = execution.state.worms.filter((w) => w.playerId === p.userId);
      const row = createNode(execution, 'div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '3px',
          marginRight: '10px',
          flexWrap: 'wrap',
        },
      });
      const nameSpan = createNode(execution, 'span', {
        style: { fontSize: '11px', marginRight: '2px' },
      });
      nameSpan.append(renderName(execution, p, { fallbackPseudo: '?' }), ':');
      row.appendChild(nameSpan);
      for (const w of mine) {
        const chip = createNode(execution, 'span', {
          style: {
            fontSize: '10px',
            padding: '1px 4px',
            borderRadius: '3px',
            marginRight: '2px',
            background: w.alive
              ? w.id === execution.state.activeWormId
                ? 'rgba(255,255,100,0.18)'
                : 'rgba(0,0,0,0.3)'
              : '#1a1a1a',
            color: w.alive ? (w.id === execution.state.activeWormId ? '#ffff88' : '#ccc') : '#555',
            border:
              w.id === execution.state.activeWormId
                ? '1px solid rgba(255,255,100,0.5)'
                : '1px solid rgba(255,255,255,0.08)',
            textDecoration: w.alive ? 'none' : 'line-through',
          },
        });
        chip.textContent = `${w.name ?? '?'} ${w.alive ? w.hp : '☠'}`;
        row.appendChild(chip);
      }
      execution.view.health.appendChild(row);
    }
  }

  function updateWeaponBtns(execution) {
    for (const [key, btn] of Object.entries(execution.view.weaponButtons)) {
      const active = key === execution.state.selectedWeapon && execution.state.isMyTurn;
      const count = Object.hasOwn(execution.state.ammo, key)
        ? Reflect.get(execution.state.ammo, key)
        : undefined;
      const noAmmo = !unlimitedAmmo(count) && count <= 0;
      btn.style.background = active ? '#2a4a1a' : '#1a1a1a';
      btn.style.border = `1px solid ${active ? '#66dd33' : '#333'}`;
      btn.style.color = noAmmo ? '#444' : active ? '#66dd33' : '#888';
      btn.style.opacity = noAmmo ? '0.45' : '1';
      btn.disabled = noAmmo;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      // Update ammo badge
      const ammoEl = btn.querySelector('[data-ammo]');
      if (ammoEl) {
        ammoEl.textContent = unlimitedAmmo(count) ? '∞' : `×${count}`;
        ammoEl.style.color = !unlimitedAmmo(count) && count <= 1 ? '#ff6644' : '#ffcc44';
      }
    }
  }

  function updateFuseDisplay(execution) {
    if (!execution.view.fuse) return;
    const isFuse =
      fuseWeapons.has(execution.state.selectedWeapon) &&
      execution.state.isMyTurn &&
      !execution.state.hasShotFired;
    if (isFuse) {
      execution.view.fuse.textContent = `⏱ ${execution.state.grenadeFuse}s`;
      execution.view.fuse.style.display = '';
    } else {
      execution.view.fuse.style.display = 'none';
    }
  }

  function showTurnAnnouncement(execution, { currentTurn, activeWormId, worms }) {
    const pl = execution.state.players.find((p) => p.userId === currentTurn);
    if (!pl) return;
    const aw =
      execution.state.worms.find((w) => w.id === activeWormId) ??
      (worms ?? []).find((w) => w.id === activeWormId);
    announcement = {
      text: `${pl.pseudo}  —  ${aw?.name ?? '?'}`,
      color: pl.color ?? '#66dd33',
      startMs: readNow(execution),
    };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }
  return {
    reset,
    stop,
    status,
    drawTurnAnnouncement: (...args) => run(drawTurnAnnouncement, args),
    updateTimerDisplay: (...args) => run(updateTimerDisplay, args),
    updateHUD: (...args) => run(updateHUD, args),
    updateHealthBar: (...args) => run(updateHealthBar, args),
    updateWeaponBtns: (...args) => run(updateWeaponBtns, args),
    updateFuseDisplay: (...args) => run(updateFuseDisplay, args),
    showTurnAnnouncement: (...args) => run(showTurnAnnouncement, args),
  };
}
