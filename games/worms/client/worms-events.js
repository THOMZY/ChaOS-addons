export function createWormsEvents({
  socket,
  getState,
  services,
  translate: translateText,
  fuseWeapons,
  timers,
  now = () => performance.now(),
  wallNow = Date.now,
  isActive = () => true,
  logger = console,
}) {
  let session = null,
    revision = 0,
    bindingRevision = 0,
    isStopped = false,
    fuseInterval = null;
  const bindings = new Set(),
    pending = new Set(),
    cancelled = Symbol('retired Worms event');
  function isCurrent(context) {
    return (
      !isStopped &&
      isActive() &&
      session === context.session &&
      (!context.hasRound || context.revision === revision)
    );
  }
  function assertCurrent(context) {
    if (!isCurrent(context)) throw cancelled;
  }
  function readState(context) {
    const state = getState();
    assertCurrent(context);
    return state;
  }
  function invoke(context, name, ...args) {
    const result = services[name](...args);
    assertCurrent(context);
    return result;
  }
  function translate(context, ...args) {
    const result = translateText(...args);
    assertCurrent(context);
    return result;
  }
  function readClock(context, clock) {
    const value = clock();
    assertCurrent(context);
    return value;
  }
  function emit(context, ...args) {
    socket.emit(...args);
    assertCurrent(context);
  }
  function runCleanup(action) {
    try {
      action();
    } catch (error) {
      logger.warn('[worms-events] cleanup failed', error);
    }
  }
  function run(context, action) {
    if (!isCurrent(context)) return;
    try {
      action();
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function cancelTimer(entry) {
    if (!pending.delete(entry)) return;
    entry.status = 'cancelled';
    if (entry.id !== null)
      runCleanup(() => timers[entry.isInterval ? 'clearInterval' : 'clearTimeout'](entry.id));
  }
  function allocateTimer(context, action, delay, isInterval) {
    assertCurrent(context);
    const entry = { id: null, isInterval, status: 'allocating' };
    pending.add(entry);
    try {
      entry.id = timers[isInterval ? 'setInterval' : 'setTimeout'](() => {
        if (!pending.has(entry) || !isCurrent(context)) return;
        if (!isInterval) {
          pending.delete(entry);
          entry.status = 'completed';
        }
        run(context, action);
      }, delay);
      if (entry.status === 'cancelled')
        runCleanup(() => timers[isInterval ? 'clearInterval' : 'clearTimeout'](entry.id));
      else if (entry.status !== 'completed') entry.status = 'scheduled';
      assertCurrent(context);
      return entry;
    } catch (error) {
      cancelTimer(entry);
      throw error;
    }
  }
  function schedule(context, action, delay) {
    return allocateTimer(context, action, delay, false);
  }
  function repeat(context, action, delay) {
    return allocateTimer(context, action, delay, true);
  }
  function clearFuse() {
    if (fuseInterval) cancelTimer(fuseInterval);
    fuseInterval = null;
  }
  function reset() {
    revision++;
    clearFuse();
    for (const entry of [...pending]) cancelTimer(entry);
  }
  function unbind(selected = session) {
    if (session === selected) session = null;
    for (const binding of [...bindings]) {
      if (binding.session !== selected) continue;
      bindings.delete(binding);
      runCleanup(() => socket.off(binding.name, binding.callback));
    }
  }
  function listen(name, handler) {
    const boundSession = session;
    const binding = {
      name,
      session: boundSession,
      callback: (payload) => {
        if (!bindings.has(binding)) return;
        const context = { session: boundSession, revision, hasRound: true };
        run(context, () => handler(context, payload));
      },
    };
    bindings.add(binding);
    try {
      socket.on(name, binding.callback);
      assertCurrent({ session: boundSession, hasRound: false });
    } catch (error) {
      runCleanup(() => socket.off(name, binding.callback));
      bindings.delete(binding);
      throw error;
    }
  }
  function bind() {
    const attempt = ++bindingRevision;
    unbind();
    reset();
    if (isStopped || !isActive() || attempt !== bindingRevision) return false;
    const boundSession = {};
    session = boundSession;
    try {
      registerEvents();
      return true;
    } catch (error) {
      if (session === boundSession) {
        unbind(boundSession);
        reset();
      } else unbind(boundSession);
      if (error !== cancelled) throw error;
      return false;
    }
  }
  function stop() {
    isStopped = true;
    bindingRevision++;
    unbind();
    reset();
  }
  function status() {
    return {
      isStopped,
      isBound: session !== null,
      listeners: bindings.size,
      timeouts: [...pending].filter((entry) => !entry.isInterval).length,
      intervals: [...pending].filter((entry) => entry.isInterval).length,
    };
  }
  function showResultsAfter(context, data, delayMs = 900) {
    schedule(
      context,
      () => {
        const state = readState(context);
        const transition = { ...context, hasRound: false };
        invoke(transition, 'stopGame');
        state.mode = 'results';
        if (state.hasRoot)
          invoke(transition, 'renderResults', {
            winner: data.winner,
            draw: !data.winner,
            payout: 0,
          });
      },
      delayMs,
    );
  }

  // ── Apply delayed explosion (dynamite detonation or mine trigger) ─────────────
  function applyDelayedExplosion(context, data) {
    const state = readState(context);
    // data: { weapon, newHoles, wormDamages, worms, gameOver, winner, cx?, cy? }
    const holes = invoke(context, 'applyTerrainHoles', data.newHoles);

    clearFuse();

    invoke(context, 'playHoleExplosions', holes, 16, 400);
    invoke(context, 'bumpDamagedWorms', data.wormDamages, holes);

    schedule(
      context,
      () => {
        invoke(context, 'applyWormStates', data.worms);
        invoke(context, 'addDamageLabels', data.wormDamages);
        invoke(context, 'updateHealthBar');
        state.wormBumps.clear();
        if (data.gameOver) showResultsAfter(context, data);
      },
      560,
    );
  }

  function registerEvents() {
    listen('worms:rooms', (context, { rooms, liveRooms }) => {
      const state = readState(context);
      state.openRooms.length = 0;
      state.openRooms.push(...rooms);
      state.liveRooms.length = 0;
      state.liveRooms.push(...liveRooms);
      if (state.mode === 'lobby') invoke(context, 'renderLobby');
    });

    listen('worms:open', (context, room) => {
      const state = readState(context);
      invoke(context, 'noteRoomOpen', state.openRooms, room);
    });

    listen('worms:closed', (context, { roomId }) => {
      const state = readState(context);
      invoke(context, 'noteRoomClosed', state.openRooms, roomId);
      if (state.roomId === roomId && state.mode === 'waiting') {
        invoke(context, 'notify', translate(context, 'games.worms.roomCancelled'));
        state.mode = 'lobby';
        state.roomId = null;
        emit(context, 'worms:rooms_request');
        if (state.hasRoot) invoke(context, 'renderLobby');
      }
    });

    listen('worms:live_open', (context, room) => {
      const state = readState(context);
      invoke(context, 'noteRoomOpen', state.liveRooms, room);
    });

    listen('worms:live_closed', (context, { roomId }) => {
      const state = readState(context);
      invoke(context, 'noteRoomClosed', state.liveRooms, roomId);
      // Force-exit spectate if the room we were watching closed
      if (state.isSpectateMode && state.roomId === roomId) {
        state.isSpectateMode = false;
        state.mode = 'idle';
        state.roomId = null;
        context = { ...context, hasRound: false };
        invoke(context, 'stopGame');
        if (state.hasExit) invoke(context, 'onExit');
      }
    });

    // Spectate: receive full game snapshot and render read-only game view
    listen('worms:spectate_start', (context, data) => {
      const state = readState(context);
      if (!state.isSpectateMode || !state.hasRoot) return;
      state.roomId = data.roomId ?? state.roomId;
      state.mode = 'game';
      state.myUserId = null; // never our turn
      invoke(context, 'setupGame', data);
    });

    listen('worms:lobby_update', (context, room) => {
      const state = readState(context);
      invoke(context, 'upsertRoom', state.openRooms, room);
      if (state.mode === 'waiting' && state.roomId === room.id)
        invoke(context, 'renderWaiting', room);
      else if (state.mode === 'lobby') invoke(context, 'renderLobby');
    });

    ['worms:created', 'worms:joined'].forEach((eventName) => {
      listen(eventName, (context, { roomId, room }) => {
        invoke(context, 'enterWaitingRoom', roomId, room);
      });
    });

    listen('worms:start', (context, data) => {
      const state = readState(context);
      if (!state.hasRoot) return;
      state.lastBet = data.bet ?? state.lastBet;
      state.mode = 'game';
      invoke(context, 'setupGame', data);
    });

    listen('worms:pos_update', (context, { wormId, cx, cy }) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      const w = state.worms.find((w) => w.id === wormId);
      // Update any worm that's not the local player's (includes spectate where state.myUserId = null)
      if (w) {
        w.cx = cx;
        w.cy = cy;
      }
    });

    listen('worms:fire_result', (context, data) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      state.isAnimating = true;
      // NOTE: do NOT reset state.hasShotFired here — keep it true until applyNextTurn
      // to prevent the player from firing a second shot in the 2600ms window
      state.chargeStart = null;
      if (data.playerId === state.myUserId && data.ammo) {
        state.ammo = { ...data.ammo };
        invoke(context, 'updateWeaponBtns');
      }

      // Fuse sound for thrown grenades
      if (fuseWeapons.has(data.weapon)) {
        invoke(context, 'playSound', 'fuse', 0.5);
        clearFuse();
        fuseInterval = repeat(context, () => invoke(context, 'playSound', 'fuse', 0.5), 900);
      }

      // Start projectile animations — terrain stays intact until impact
      const projectileStart = readClock(context, now);
      state.projectiles = (data.trajectories ?? []).map((traj) => ({
        trajectory: traj,
        idx: 0,
        done: false,
        weapon: data.weapon ?? state.selectedWeapon,
        startMs: projectileStart,
        fuseMs: data.fuseMs ?? null,
      }));

      // Calculate how long projecting takes
      // Minimum 500ms so even short-trajectory shots show the explosion
      const maxLen = Math.max(1, ...state.projectiles.map((p) => p.trajectory.length));
      // At PROJ_PTS_PER_SEC=20, animation takes maxLen/20 seconds. Add 200ms buffer.
      const projMs = Math.max(500, Math.ceil((maxLen * 1000) / 20) + 200);

      schedule(
        context,
        () => {
          // Apply terrain holes at impact moment (synchronized with explosion FX)
          const impactHoles = invoke(context, 'applyTerrainHoles', data.newHoles);

          // Stop fuse sound
          clearFuse();

          // Explosions at impact points (skip for planted / teleport)
          if (invoke(context, 'playHoleExplosions', impactHoles, 14, 320)) {
            // Explosion handled by shared VFX helper.
          } else if (data.teleported) {
            // Small teleport pop FX at landing position
            const lw = state.worms.find((w) => w.id === state.activeWormId);
            if (lw) invoke(context, 'spawnParticles', data.cx ?? lw.cx, data.cy ?? lw.cy, 7);
            invoke(context, 'playSound', 'TELEPORT', 0.5);
          } else if (data.planted) {
            // Placement sound
            invoke(context, 'playSound', 'PLACE', 0.4);
            // Store dynamite/mine client-side
            if (data.planted && data.weapon === 'dynamite' && data.dynId) {
              // placedAt derived from server fuseStarted so countdown stays in sync across clients
              const elapsedMs = data.fuseStarted
                ? readClock(context, wallNow) - data.fuseStarted
                : 0;
              state.dynamites.push({
                id: data.dynId,
                cx: data.cx,
                cy: data.cy,
                fuseMs: data.fuseMs ?? 5000,
                placedAt: readClock(context, now) - elapsedMs,
              });
            }
            if (data.planted && data.weapon === 'land_mine' && data.mineId) {
              state.mines.push({ id: data.mineId, cx: data.cx, cy: data.cy });
            }
          }

          // ── Visual hit-reaction: push damaged worms away from nearest explosion
          invoke(context, 'bumpDamagedWorms', data.wormDamages, impactHoles, {
            bat: data.weapon === 'bat',
          });

          schedule(
            context,
            () => {
              // Apply worm states and damage labels
              invoke(context, 'applyWormStates', data.worms, { teleported: data.teleported });
              invoke(context, 'addDamageLabels', data.wormDamages);
              invoke(context, 'updateHealthBar');
              state.projectiles = [];
              state.wormBumps.clear(); // snap to final server positions
              state.isAnimating = false;

              if (data.gameOver) {
                showResultsAfter(context, data);
              } else if (state.pendingNextTurn) {
                invoke(context, 'applyNextTurn', state.pendingNextTurn);
                state.pendingNextTurn = null;
              }
            },
            560,
          );
        },
        projMs,
      );
    });

    listen('worms:tool_used', (context, { playerId, ammo }) => {
      const state = readState(context);
      if (state.mode !== 'game' || playerId !== state.myUserId || !ammo) return;
      state.ammo = { ...ammo };
      invoke(context, 'updateWeaponBtns');
    });

    listen('worms:drowned', (context, data) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      invoke(context, 'applyWormStates', data.worms);
      invoke(context, 'addDamageLabels', data.wormDamages);
      invoke(context, 'updateHealthBar');
      invoke(context, 'playRandomSpeech', 'byebye');
    });

    listen('worms:next_turn', (context, data) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      if (state.isAnimating) {
        state.pendingNextTurn = data;
      } else {
        invoke(context, 'applyNextTurn', data);
      }
    });

    listen('worms:delayed_explosion', (context, data) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      // Remove from local lists
      if (data.weapon === 'dynamite' && data.dynId) {
        state.dynamites = state.dynamites.filter((d) => d.id !== data.dynId);
      }
      if (data.weapon === 'land_mine' && data.mineId) {
        state.mines = state.mines.filter((m) => m.id !== data.mineId);
      }
      applyDelayedExplosion(context, data);
    });

    listen('worms:game_over', (context, data) => {
      const state = readState(context);
      context = { ...context, hasRound: false };
      if (state.mode !== 'game' && state.mode !== 'results') return;
      if (state.isSpectateMode) {
        const winner = data.winner?.pseudo;
        state.isSpectateMode = false;
        state.mode = 'idle';
        state.roomId = null;
        invoke(context, 'stopGame');
        if (state.hasExit) invoke(context, 'onExit');
        if (winner)
          invoke(
            context,
            'notify',
            translate(context, 'games.worms.spectatorWinner', { player: winner }),
          );
        return;
      }
      invoke(context, 'stopGame');
      state.mode = 'results';
      if (state.hasRoot) invoke(context, 'renderResults', data);
    });

    listen('worms:rematch_waiting', (context, { roomId }) => {
      const state = readState(context);
      if (state.roomId !== roomId) return;
      invoke(context, 'markRematchWaiting');
    });

    listen('worms:rematch_lobby', (context, { roomId, room }) => {
      const state = readState(context);
      state.roomId = roomId;
      state.lastBet = room?.bet ?? state.lastBet;
      state.mode = 'waiting';
      invoke(context, 'renderWaiting', room);
    });

    listen('worms:post_exit', (context, { roomId, reason }) => {
      const state = readState(context);
      if (state.roomId && roomId !== state.roomId) return;
      if (reason === 'insufficient_balance')
        invoke(context, 'notify', translate(context, 'games.worms.rematchInsufficientBalance'));
      invoke(context, 'exit');
    });

    listen('worms:forfeit_player', (context, { userId, pseudo }) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      const p = state.players.find((p) => p.userId === userId);
      invoke(
        context,
        'notify',
        translate(context, 'games.worms.playerForfeited', { player: p?.pseudo ?? pseudo }),
      );
    });

    listen('worms:retreat', (context, { retreatMs }) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      state.isRetreating = true;
      state.retreatEnd = readClock(context, wallNow) + (retreatMs ?? 5000);
      // Allow movement but no firing during retreat
      state.hasShotFired = true;
    });

    listen('worms:worm_selected', (context, { activeWormId }) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      state.activeWormId = activeWormId;
      invoke(context, 'clearSprites');
      invoke(context, 'initWsTurn');
      invoke(context, 'updateHUD');
    });

    listen('worms:crate_spawn', (context, { crate }) => {
      const state = readState(context);
      if (state.mode !== 'game' || !crate) return;
      // Crate starts at top of screen and falls down to its landing y
      state.crates.push({ ...crate, landed: false, fallingCy: -30 });
      invoke(context, 'playSound', 'CrateOpen', 0.4);
    });

    listen('worms:crate_collected', (context, { crateId, type, weapon, wormId, hp, ammo }) => {
      const state = readState(context);
      if (state.mode !== 'game') return;
      state.crates = state.crates.filter((c) => c.id !== crateId);
      const worm = state.worms.find((w) => w.id === wormId);
      if (worm && hp !== undefined) worm.hp = hp;
      // Apply updated ammo if this worm belongs to us
      if (ammo && wormId === state.activeWormId) {
        state.ammo = ammo;
        invoke(context, 'updateWeaponBtns');
      }
      if (type === 'health') {
        invoke(
          context,
          'notify',
          translate(context, 'games.worms.healthPickup', { worm: worm?.name ?? '?' }),
        );
        if (wormId === state.activeWormId) invoke(context, 'playRandomSpeech', 'yessir');
      } else if (weapon) {
        invoke(
          context,
          'notify',
          translate(context, 'games.worms.weaponPickup', {
            worm: worm?.name ?? '?',
            weapon: invoke(context, 'weaponLabel', weapon),
          }),
        );
        if (wormId === state.activeWormId) invoke(context, 'playRandomSpeech', 'yessir');
      }
      invoke(context, 'updateHealthBar');
    });

    listen('worms:error', (context, { error }) => {
      const state = readState(context);
      const msgs = {
        insufficient_balance: translate(context, 'games.worms.error.insufficientBalance'),
        already_in_room: translate(context, 'games.worms.error.alreadyInRoom'),
        not_found: translate(context, 'games.worms.error.notFound'),
        room_full: translate(context, 'games.worms.error.roomFull'),
        already_started: translate(context, 'games.worms.error.alreadyStarted'),
        not_your_turn: translate(context, 'games.worms.error.notYourTurn'),
        need_more_players: translate(context, 'games.worms.error.needMorePlayers'),
        no_ammo: translate(context, 'games.worms.error.noAmmo'),
        invalid_target: translate(context, 'games.worms.error.invalidTarget'),
        invalid_angle: translate(context, 'games.worms.error.invalidAngle'),
        action_taken: translate(context, 'games.worms.error.actionTaken'),
      };
      if (['no_ammo', 'invalid_target', 'invalid_angle'].includes(error)) {
        state.hasShotFired = false;
        state.hasMovementToolUsed = false;
        state.rope = null;
        state.isJetpackActive = false;
        state.chargeStart = null;
        invoke(context, 'updateHUD');
      }
      invoke(
        context,
        'notify',
        Object.hasOwn(msgs, error)
          ? Reflect.get(msgs, error)
          : `❌ Worms: ${translate(context, 'games.unknownError')}`,
      );
    });
  }

  return { bind, reset, stop, status };
}
