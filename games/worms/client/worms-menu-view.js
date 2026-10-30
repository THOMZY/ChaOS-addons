export function createWormsMenuView({
  getState,
  createElement,
  translate: t,
  setSafeHtml,
  colorSpan,
  levels,
  actions,
  isActive = () => true,
  logger = console,
}) {
  let current = null,
    isStopped = false;
  const cancelled = Symbol('retired menu view');
  const mapNames = levels.map((level) => `${level.emoji} ${level.name}`);
  const getLevel = (index) => levels[index] ?? levels[0];
  function isCurrent(session) {
    return !isStopped && current === session && isActive();
  }
  function assertCurrent(session) {
    if (!isCurrent(session)) throw cancelled;
  }
  function createNode(session, ...args) {
    assertCurrent(session);
    const node = createElement(...args);
    session.nodes.add(node);
    assertCurrent(session);
    return node;
  }
  function translateLabel(session, ...args) {
    const label = t(...args);
    assertCurrent(session);
    return label;
  }
  function writeHtml(session, node, html) {
    setSafeHtml(node, html);
    assertCurrent(session);
  }
  function renderName(session, ...args) {
    const html = colorSpan(...args);
    assertCurrent(session);
    return html;
  }
  function listen(session, node, action) {
    const binding = {
      node,
      callback: () => {
        if (!isCurrent(session)) return;
        try {
          action();
        } catch (error) {
          if (error !== cancelled) throw error;
        }
      },
    };
    session.bindings.add(binding);
    node.addEventListener('click', binding.callback);
    assertCurrent(session);
  }
  function release(session) {
    for (const binding of session.bindings) {
      try {
        binding.node.removeEventListener('click', binding.callback);
      } catch (error) {
        logger.warn('[worms-menu-view] listener cleanup failed', error);
      }
    }
    session.bindings.clear();
    for (const node of session.nodes) {
      try {
        node.remove();
      } catch (error) {
        logger.warn('[worms-menu-view] node cleanup failed', error);
      }
    }
    session.nodes.clear();
  }
  function reset() {
    const previous = current;
    current = null;
    if (previous) release(previous);
  }
  function mount(root, screen, data) {
    reset();
    if (isStopped || !isActive() || !root) return false;
    const session = { root, nodes: new Set(), bindings: new Set() };
    current = session;
    try {
      root.replaceChildren();
      assertCurrent(session);
      if (screen === 'lobby') renderLobby(session);
      else if (screen === 'waiting') renderWaiting(session, data);
      else if (screen === 'results') renderResults(session, data);
      else throw new Error(`Unknown Worms menu screen: ${screen}`);
      assertCurrent(session);
      return true;
    } catch (error) {
      if (current === session) current = null;
      release(session);
      if (error !== cancelled) throw error;
      return false;
    }
  }
  function stop() {
    isStopped = true;
    reset();
  }
  function markRematchWaiting() {
    const session = current;
    if (!session || !isCurrent(session) || !session.replayButton) return;
    try {
      const label = translateLabel(session, 'games.worms.waiting');
      session.replayButton.disabled = true;
      session.replayButton.style.opacity = '0.65';
      session.replayButton.textContent = label;
    } catch (error) {
      if (error !== cancelled) throw error;
    }
  }
  function status() {
    return {
      isStopped,
      isMounted: current !== null,
      nodes: current?.nodes.size ?? 0,
      listeners: current?.bindings.size ?? 0,
    };
  }
  function renderLobby(session) {
    const { openRooms, liveRooms } = getState();
    assertCurrent(session);
    const root = session.root;
    root.dataset.gameMode = 'worms-menu';
    root.style.cssText = 'padding:10px;overflow:auto;background:#0f1014;color:#fff;';

    const wrap = createNode(session, 'div', {
      style: { fontFamily: 'monospace', maxWidth: '600px', margin: '0 auto' },
    });

    // Header
    wrap.appendChild(
      createNode(
        session,
        'h3',
        { style: { color: '#66dd33', marginBottom: '8px', textAlign: 'center' } },
        `🪱 Worms — ${translateLabel(session, 'games.type.freeForAll')}`,
      ),
    );

    // Bet + create row
    const createRow = createNode(session, 'div', {
      style: { display: 'flex', gap: '6px', marginBottom: '8px' },
    });
    const betInput = createNode(session, 'input', {
      type: 'number',
      min: '0',
      placeholder: translateLabel(session, 'games.worms.betPlaceholder'),
      'aria-label': translateLabel(session, 'games.worms.betLabel'),
      style: {
        flex: '1',
        padding: '5px 8px',
        background: '#1e2028',
        border: '1px solid #444',
        color: '#fff',
        borderRadius: '4px',
        fontSize: '13px',
      },
    });
    const maxSel = createNode(session, 'select', {
      'aria-label': translateLabel(session, 'games.worms.maxPlayers'),
      style: {
        padding: '5px',
        background: '#1e2028',
        border: '1px solid #444',
        color: '#fff',
        borderRadius: '4px',
        fontSize: '13px',
      },
    });
    [2, 3, 4, 5, 6, 7, 8].forEach((n) => {
      const opt = createNode(session, 'option');
      opt.value = n;
      opt.textContent = translateLabel(session, 'games.worms.playerCount', { count: n });
      if (n === 4) opt.selected = true;
      maxSel.appendChild(opt);
    });
    const createBtn = createNode(
      session,
      'button',
      {
        class: 'btn games-create-btn',
        style: {
          background: 'linear-gradient(135deg,#3d8a2c,#7a5230)',
          color: '#fff',
          padding: '5px 14px',
          borderRadius: '4px',
          border: 'none',
          cursor: 'pointer',
          fontSize: '13px',
          whiteSpace: 'nowrap',
        },
      },
      translateLabel(session, 'games.worms.create'),
    );
    listen(session, createBtn, () => {
      const bet = Math.max(0, parseInt(betInput.value, 10) || 0);
      actions.create(bet, parseInt(maxSel.value, 10));
    });
    createRow.append(betInput, maxSel, createBtn);
    wrap.appendChild(createRow);

    // Open rooms
    const roomsTitle = createNode(
      session,
      'div',
      {
        style: { fontSize: '12px', color: '#999', marginBottom: '4px', marginTop: '8px' },
      },
      translateLabel(session, 'games.worms.openRooms', { count: openRooms.length }),
    );
    wrap.appendChild(roomsTitle);

    if (openRooms.length === 0) {
      wrap.appendChild(
        createNode(
          session,
          'div',
          { style: { fontSize: '12px', color: '#555', marginBottom: '6px' } },
          translateLabel(session, 'games.worms.noRooms'),
        ),
      );
    } else {
      for (const r of openRooms) {
        wrap.appendChild(buildRoomRow(session, r));
      }
    }

    // Live rooms
    if (liveRooms.length > 0) {
      wrap.appendChild(
        createNode(
          session,
          'div',
          {
            style: { fontSize: '12px', color: '#999', marginTop: '8px', marginBottom: '4px' },
          },
          translateLabel(session, 'games.worms.liveRooms', { count: liveRooms.length }),
        ),
      );
      for (const r of liveRooms) {
        const row = createNode(session, 'div', {
          style: {
            background: '#1a2012',
            border: '1px solid #2d4020',
            borderRadius: '4px',
            padding: '6px 8px',
            marginBottom: '4px',
            fontSize: '12px',
            color: '#aaa',
          },
        });
        const names = r.players.map((p) => renderName(session, p.pseudo, p.color)).join(', ');
        writeHtml(
          session,
          row,
          `<span style="color:#66dd33">▶ ${translateLabel(session, 'games.worms.live')}</span> ${names} — ${translateLabel(session, 'games.worms.betShort', { bet: r.bet })}`,
        );
        // Spectating starts here since Worms has its own window (roadmap J5c).
        const watch = createNode(
          session,
          'button',
          {
            type: 'button',
            class: 'btn small',
            'data-worms-watch': r.id,
            style: { marginLeft: '8px' },
          },
          `👁 ${translateLabel(session, 'games.lobby.watch')}`,
        );
        listen(session, watch, () => actions.watch(r.id));
        row.appendChild(watch);
        wrap.appendChild(row);
      }
    }

    root.appendChild(wrap);

    // Back button
    const backBtn = createNode(
      session,
      'button',
      {
        style: {
          marginTop: '10px',
          background: '#333',
          color: '#ccc',
          border: 'none',
          padding: '5px 14px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
          display: 'block',
          marginLeft: 'auto',
          marginRight: 'auto',
        },
      },
      translateLabel(session, 'games.worms.back'),
    );
    listen(session, backBtn, actions.exit);
    root.appendChild(backBtn);
  }

  function buildRoomRow(session, r) {
    const row = createNode(session, 'div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#161a1e',
        border: '1px solid #333',
        borderRadius: '4px',
        padding: '5px 8px',
        marginBottom: '4px',
        fontSize: '13px',
      },
    });
    const names = r.players.map((p) => renderName(session, p.pseudo, p.color)).join(', ');
    const left = createNode(session, 'span', {});
    writeHtml(
      session,
      left,
      `${names} — <span style="color:#aaa">${r.players.length}/${r.maxPlayers}</span> — <span style="color:#f8c200">${r.bet} pts</span>`,
    );
    const joinBtn = createNode(
      session,
      'button',
      {
        style: {
          background: '#1d4a28',
          color: '#66dd33',
          border: '1px solid #2d6a38',
          padding: '3px 10px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
        },
      },
      translateLabel(session, 'games.worms.join'),
    );
    joinBtn.setAttribute('data-game-focus', `worms:join:${r.id}`);
    joinBtn.setAttribute(
      'aria-label',
      translateLabel(session, 'games.worms.joinRoom', {
        players: r.players.map((p) => p.pseudo).join(', '),
      }),
    );
    listen(session, joinBtn, () => {
      actions.join(r);
    });
    row.append(left, joinBtn);
    return row;
  }

  function renderWaiting(session, room) {
    const { myUserId, selectedTheme } = getState();
    assertCurrent(session);
    const root = session.root;
    root.dataset.gameMode = 'worms-menu';
    root.style.cssText = 'padding:10px;overflow:auto;background:#0f1014;color:#fff;';

    const wrap = createNode(session, 'div', {
      style: { fontFamily: 'monospace', maxWidth: '500px', margin: '0 auto', textAlign: 'center' },
    });
    wrap.appendChild(
      createNode(
        session,
        'h3',
        { style: { color: '#66dd33', marginBottom: '10px' } },
        translateLabel(session, 'games.worms.waitingRoom'),
      ),
    );

    const betInfo = createNode(
      session,
      'div',
      { style: { color: '#f8c200', marginBottom: '8px', fontSize: '13px' } },
      translateLabel(session, 'games.worms.roomSummary', {
        bet: room.bet,
        players: room.players.length,
        maxPlayers: room.maxPlayers,
      }),
    );
    wrap.appendChild(betInfo);

    const list = createNode(session, 'div', { style: { marginBottom: '12px' } });
    for (const p of room.players) {
      const row = createNode(session, 'div', { style: { padding: '3px 0', fontSize: '13px' } });
      writeHtml(session, row, renderName(session, p.pseudo, p.color));
      list.appendChild(row);
    }
    wrap.appendChild(list);

    const waiting = createNode(
      session,
      'div',
      { style: { color: '#888', fontSize: '12px', marginBottom: '12px' } },
      translateLabel(session, 'games.worms.waitingForPlayers'),
    );
    wrap.appendChild(waiting);

    const btnRow = createNode(session, 'div', {
      style: { display: 'flex', gap: '8px', justifyContent: 'center' },
    });
    const isCreator = room.players.length > 0 && room.players[0].userId === myUserId;

    // Map selector — only the creator can change it
    const mapSection = createNode(session, 'div', { style: { marginBottom: '12px' } });
    mapSection.appendChild(
      createNode(
        session,
        'div',
        { style: { fontSize: '11px', color: '#888', marginBottom: '5px' } },
        translateLabel(session, 'games.worms.map'),
      ),
    );
    const mapRow = createNode(session, 'div', {
      style: { display: 'flex', gap: '5px', justifyContent: 'center', flexWrap: 'wrap' },
    });
    mapNames.forEach((name, i) => {
      const btn = createNode(
        session,
        'button',
        {
          style: {
            background: selectedTheme === i ? getLevel(i).skyB : '#1a1a1a',
            color: selectedTheme === i ? '#fff' : '#888',
            border: `1px solid ${selectedTheme === i ? '#aaa' : '#333'}`,
            padding: '4px 8px',
            borderRadius: '4px',
            cursor: isCreator ? 'pointer' : 'default',
            fontSize: '11px',
            opacity: isCreator ? '1' : '0.6',
          },
        },
        name,
      );
      if (isCreator) {
        listen(session, btn, () => {
          actions.selectTheme(i, room);
        });
      }
      mapRow.appendChild(btn);
    });
    mapSection.appendChild(mapRow);
    wrap.appendChild(mapSection);

    if (isCreator) {
      const launchBtn = createNode(
        session,
        'button',
        {
          style: {
            background:
              room.players.length < 2 ? '#2a3a2a' : 'linear-gradient(135deg,#3d8a2c,#7a5230)',
            color: '#fff',
            border: 'none',
            padding: '7px 18px',
            borderRadius: '4px',
            cursor: room.players.length < 2 ? 'not-allowed' : 'pointer',
            fontSize: '13px',
          },
        },
        translateLabel(session, 'games.worms.launch'),
      );
      if (room.players.length >= 2) {
        listen(session, launchBtn, () => actions.launch());
      }
      btnRow.appendChild(launchBtn);
    }

    const leaveBtn = createNode(
      session,
      'button',
      {
        style: {
          background: '#3a1414',
          color: '#ff7777',
          border: '1px solid #5a2020',
          padding: '7px 14px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '13px',
        },
      },
      translateLabel(session, 'games.worms.leave'),
    );
    listen(session, leaveBtn, () => {
      actions.leaveWaiting();
    });
    btnRow.appendChild(leaveBtn);
    wrap.appendChild(btnRow);
    root.appendChild(wrap);
  }

  function renderResults(session, data) {
    assertCurrent(session);
    const root = session.root;
    root.dataset.gameMode = 'worms-menu';
    root.style.cssText =
      'padding:14px;overflow:auto;background:#0f1014;color:#fff;text-align:center;';

    const wrap = createNode(session, 'div', {
      style: { fontFamily: 'monospace', maxWidth: '500px', margin: '0 auto' },
    });

    if (data.draw || !data.winner) {
      wrap.appendChild(
        createNode(
          session,
          'h2',
          { style: { color: '#ffcc00' } },
          translateLabel(session, 'games.worms.draw'),
        ),
      );
      wrap.appendChild(
        createNode(
          session,
          'p',
          { style: { color: '#aaa' } },
          translateLabel(session, 'games.worms.everyoneDied'),
        ),
      );
    } else {
      const w = data.winner;
      const h2 = createNode(session, 'h2', { style: { color: w.color ?? '#66dd33' } });
      h2.textContent = translateLabel(session, 'games.worms.winner', { player: w.pseudo });
      wrap.appendChild(h2);
      if (data.payout > 0) {
        wrap.appendChild(
          createNode(
            session,
            'p',
            { style: { color: '#f8c200', fontSize: '15px' } },
            `+${data.payout} pts`,
          ),
        );
      }
    }

    const btnRow = createNode(session, 'div', {
      style: { marginTop: '16px', display: 'flex', gap: '10px', justifyContent: 'center' },
    });

    const replayBtn = createNode(
      session,
      'button',
      {
        id: 'worms-rematch-btn',
        style: {
          background: 'linear-gradient(135deg,#3d8a2c,#7a5230)',
          color: '#fff',
          border: 'none',
          padding: '8px 18px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '14px',
        },
      },
      translateLabel(session, 'games.worms.playAgain'),
    );
    session.replayButton = replayBtn;
    listen(session, replayBtn, () => {
      if (replayBtn.disabled) return;
      if (!actions.canRematch() || !isCurrent(session)) return;
      const label = translateLabel(session, 'games.worms.rematchSent');
      replayBtn.disabled = true;
      replayBtn.style.opacity = '0.65';
      replayBtn.textContent = label;
      actions.rematch();
    });

    const quitBtn = createNode(
      session,
      'button',
      {
        style: {
          background: '#2a1818',
          color: '#ff7777',
          border: '1px solid #5a2828',
          padding: '8px 18px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '14px',
        },
      },
      translateLabel(session, 'games.worms.leave'),
    );
    listen(session, quitBtn, () => {
      actions.leaveResults();
    });

    btnRow.append(replayBtn, quitBtn);
    wrap.appendChild(btnRow);
    root.appendChild(wrap);
  }

  return { mount, reset, stop, status, markRematchWaiting };
}
