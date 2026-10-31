export function createWormsGameView({
  getState,
  createElement,
  weapons,
  getWeaponLabel,
  getWeaponIconName,
  translate,
  formatKey = (key) => key,
  attachInput,
  detachInput,
  mountTerrain,
  onSelectWeapon,
  onQuitSpectating,
  onEndTurn,
  onForfeit,
  confirm = (message) => globalThis.confirm(message),
  isActive = () => true,
  logger = console,
  width = 960,
  height = 480,
  assetsBase = '/worms-assets',
}) {
  let isStopped = false,
    current = null;
  const cancelled = Symbol('retired game view');
  function isCurrent(session) {
    return !isStopped && current === session && isActive();
  }
  function assertCurrent(session) {
    if (!isCurrent(session)) throw cancelled;
  }
  function release(action) {
    try {
      action();
    } catch (error) {
      logger.warn('[worms-game-view] cleanup failed', error);
    }
  }
  function createNode(session, ...args) {
    const node = createElement(...args);
    session.nodes.add(node);
    if (node.tagName === 'IMG') session.images.add(node);
    assertCurrent(session);
    return node;
  }
  function translateLabel(session, key) {
    const value = translate(key);
    assertCurrent(session);
    return value;
  }
  function readWeaponLabel(session, key) {
    const value = getWeaponLabel(key);
    assertCurrent(session);
    return value;
  }
  function readIconName(session, key) {
    const value = getWeaponIconName(key);
    assertCurrent(session);
    return value;
  }
  function confirmAction(session, message) {
    const value = confirm(message);
    assertCurrent(session);
    return value;
  }
  function listen(session, node, type, action, once = false) {
    const binding = { node, type, callback: null };
    const remove = () => {
      session.bindings.delete(binding);
      node.removeEventListener(type, binding.callback);
    };
    binding.callback = (event) => {
      if (!session.bindings.has(binding) || !isCurrent(session)) return;
      if (once) remove();
      try {
        action(event);
      } catch (error) {
        if (error !== cancelled) throw error;
      }
    };
    session.bindings.add(binding);
    node.addEventListener(type, binding.callback);
    assertCurrent(session);
  }
  function attachArena(session, canvas, name, help) {
    session.inputCanvas = canvas;
    try {
      attachInput(canvas, name, help);
      assertCurrent(session);
    } catch (error) {
      release(() => detachInput(canvas));
      throw error;
    }
  }
  function readCanvasContext(session, canvas) {
    const context = canvas.getContext('2d');
    assertCurrent(session);
    return context;
  }
  function mountTerrainView(session) {
    assertCurrent(session);
    mountTerrain();
    assertCurrent(session);
  }
  function dispose(session) {
    if (!session) return;
    for (const binding of session.bindings)
      release(() => binding.node.removeEventListener(binding.type, binding.callback));
    session.bindings.clear();
    if (session.inputCanvas) {
      release(() => detachInput(session.inputCanvas));
      session.inputCanvas = null;
    }
    for (const image of session.images) release(() => image.removeAttribute('src'));
    session.images.clear();
    for (const node of session.nodes) {
      if (node.tagName === 'CANVAS')
        release(() => {
          node.width = 0;
          node.height = 0;
        });
      release(() => node.remove());
    }
    session.nodes.clear();
  }
  function reset() {
    const previous = current;
    current = null;
    dispose(previous);
  }
  function stop() {
    if (isStopped) return;
    isStopped = true;
    reset();
  }
  function status() {
    return {
      isStopped,
      hasView: current !== null,
      listeners: current?.bindings.size ?? 0,
      images: current?.images.size ?? 0,
    };
  }
  function mount(root) {
    if (isStopped || !isActive()) return null;
    reset();
    const session = {
      root,
      state: null,
      view: {},
      nodes: new Set(),
      images: new Set(),
      bindings: new Set(),
      inputCanvas: null,
    };
    current = session;
    try {
      session.state = getState();
      assertCurrent(session);
      buildGameLayout(session);
      assertCurrent(session);
      return session.view;
    } catch (error) {
      if (current === session) current = null;
      dispose(session);
      if (error !== cancelled) throw error;
      return null;
    }
  }
  function buildGameLayout(session) {
    session.root.replaceChildren();
    session.root.style.cssText =
      'padding:0;overflow:hidden;background:#0a0a0f;position:relative;display:flex;flex-direction:column;';
    session.root.appendChild(buildTopBar(session));
    session.root.appendChild(buildCanvasArea(session));
    session.root.appendChild(buildBottomControls(session));
    session.view.health = buildHealthList(session);
    session.root.appendChild(session.view.health);
  }

  function buildTopBar(session) {
    const topBar = createNode(session, 'div', {
      class: 'worms-topbar',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        background: '#111',
        padding: '4px 10px',
        height: '28px',
        flexShrink: '0',
        fontFamily: 'monospace',
        fontSize: '13px',
        color: '#fff',
        boxSizing: 'border-box',
      },
    });
    session.view.turnLabel = createNode(session, 'span', { style: { color: '#66dd33' } }, '');
    session.view.turnLabel.setAttribute('data-game-status', '');
    session.view.timer = createNode(
      session,
      'span',
      { style: { color: '#ffcc00', fontWeight: 'bold' } },
      '',
    );
    session.view.wind = createNode(
      session,
      'span',
      { style: { color: '#aaddff', fontSize: '12px' } },
      '',
    );
    session.view.muteButton = buildMuteButton(session);
    topBar.append(
      session.view.turnLabel,
      session.view.wind,
      session.view.timer,
      session.view.muteButton,
    );
    return topBar;
  }

  function buildMuteButton(session) {
    const btn = createNode(
      session,
      'button',
      {
        style: {
          background: 'none',
          border: '1px solid #333',
          color: '#aaa',
          padding: '2px 5px',
          borderRadius: '3px',
          cursor: 'pointer',
          fontSize: '13px',
          lineHeight: '1',
          marginLeft: '4px',
          flexShrink: '0',
        },
      },
      session.state.isMuted ? '🔇' : '🔊',
    );
    btn.title = translateLabel(session, 'games.worms.soundToggle');
    btn.setAttribute('aria-label', translateLabel(session, 'games.worms.sound'));
    btn.setAttribute('aria-pressed', String(!session.state.isMuted));
    listen(session, btn, 'click', () => {
      session.state.isMuted = !session.state.isMuted;
      assertCurrent(session);
      btn.textContent = session.state.isMuted ? '🔇' : '🔊';
      btn.setAttribute('aria-pressed', String(!session.state.isMuted));
    });
    return btn;
  }

  function buildCanvasArea(session) {
    session.view.container = createNode(session, 'div', {
      class: 'worms-stage',
      style: {
        flex: '1',
        overflow: 'hidden',
        position: 'relative',
        lineHeight: '0',
      },
    });
    session.view.canvas = createNode(session, 'canvas');
    session.view.canvas.width = width;
    attachArena(
      session,
      session.view.canvas,
      'Worms',
      translateLabel(session, 'games.worms.controls'),
    );
    session.view.canvas.height = height;
    session.view.canvas.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;cursor:crosshair;touch-action:none;display:block;';
    session.view.container.appendChild(session.view.canvas);
    session.view.context = readCanvasContext(session, session.view.canvas);

    mountTerrainView(session);
    return session.view.container;
  }

  function buildBottomControls(session) {
    const bottomBar = createNode(session, 'div', {
      class: 'worms-toolbar',
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        background: '#111',
        padding: '4px 8px',
        flexShrink: '0',
        fontFamily: 'monospace',
        fontSize: '12px',
        boxSizing: 'border-box',
      },
    });
    buildWeaponButtons(session, bottomBar);
    bottomBar.appendChild(createNode(session, 'div', { style: { flex: '1' } }));
    if (session.state.isSpectateMode) buildSpectateControls(session, bottomBar);
    else buildPlayerControls(session, bottomBar);
    bottomBar.appendChild(buildFuseIndicator(session));
    return bottomBar;
  }

  function buildWeaponButtons(session, bottomBar) {
    session.view.weaponButtons = Object.create(null);
    for (const [key, def] of Object.entries(weapons)) {
      const btn = buildWeaponButton(session, key, def);
      Reflect.set(session.view.weaponButtons, key, btn);
      bottomBar.appendChild(btn);
    }
  }

  function buildWeaponButton(session, key, def) {
    const isActive = key === session.state.selectedWeapon;
    const btn = createNode(session, 'button', {
      class: 'worms-weapon-btn',
      style: {
        background: isActive ? '#2a4a1a' : '#1a1a1a',
        color: isActive ? '#66dd33' : '#888',
        border: `1px solid ${isActive ? '#66dd33' : '#333'}`,
        padding: '2px 3px',
        borderRadius: '4px',
        cursor: 'pointer',
        transition: 'background 0.15s',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '1px',
        minWidth: '32px',
        lineHeight: '1',
        boxSizing: 'border-box',
      },
    });
    const label = readWeaponLabel(session, key);
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(isActive));
    const lbl = buildWeaponKeyLabel(session, def.key);
    btn.appendChild(buildWeaponIcon(session, key, def, btn, lbl));
    btn.appendChild(lbl);
    btn.appendChild(buildAmmoLabel(session, key));
    listen(session, btn, 'click', () => onSelectWeapon(key));
    return btn;
  }

  function buildWeaponIcon(session, key, def, btn, lbl) {
    const iconImg = createNode(session, 'img');
    const iconName = readIconName(session, key);
    iconImg.style.cssText = 'width:22px;height:22px;image-rendering:pixelated;display:block;';
    listen(
      session,
      iconImg,
      'error',
      () => {
        iconImg.style.display = 'none';
        const em = createNode(session, 'span');
        em.style.cssText =
          'font-size:15px;line-height:22px;display:block;width:22px;text-align:center;';
        em.textContent = def.icon;
        btn.insertBefore(em, lbl);
      },
      true,
    );
    iconImg.src = assetsBase + '/images/weaponicons/' + (iconName ?? 'iconbazooka') + '.png';
    if (!isCurrent(session)) {
      release(() => iconImg.removeAttribute('src'));
      throw cancelled;
    }
    return iconImg;
  }

  function buildWeaponKeyLabel(session, key) {
    const lbl = createNode(session, 'span');
    lbl.style.cssText = 'font-size:8px;font-family:monospace;opacity:0.7;';
    lbl.textContent = formatKey(key);
    return lbl;
  }

  function buildAmmoLabel(session, key) {
    const ammoEl = createNode(session, 'span');
    ammoEl.dataset.ammo = key;
    ammoEl.style.cssText = 'font-size:7px;font-family:monospace;color:#ffcc44;min-height:8px;';
    return ammoEl;
  }

  function buildSpectateControls(session, bottomBar) {
    const quitBtn = createNode(
      session,
      'button',
      {
        style: {
          background: '#2a1818',
          color: '#ff8888',
          border: '1px solid #5a2828',
          padding: '3px 12px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
        },
      },
      translateLabel(session, 'games.worms.leaveSpectator'),
    );
    listen(session, quitBtn, 'click', onQuitSpectating);
    bottomBar.appendChild(quitBtn);
  }

  function buildPlayerControls(session, bottomBar) {
    bottomBar.appendChild(buildEndTurnButton(session));
    bottomBar.appendChild(buildForfeitButton(session));
  }

  function buildEndTurnButton(session) {
    const endTurnBtn = createNode(
      session,
      'button',
      {
        style: {
          background: '#2a1818',
          color: '#ff8888',
          border: '1px solid #5a2828',
          padding: '3px 10px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '12px',
        },
      },
      translateLabel(session, 'games.worms.endTurn'),
    );
    listen(session, endTurnBtn, 'click', () => {
      onEndTurn();
    });
    return endTurnBtn;
  }

  function buildForfeitButton(session) {
    const forfeitBtn = createNode(
      session,
      'button',
      {
        style: {
          background: '#1a1a1a',
          color: '#888',
          border: '1px solid #333',
          padding: '3px 8px',
          borderRadius: '4px',
          cursor: 'pointer',
          fontSize: '11px',
        },
      },
      '✗',
    );
    forfeitBtn.title = translateLabel(session, 'games.forfeit');
    listen(session, forfeitBtn, 'click', () => {
      if (confirmAction(session, translateLabel(session, 'games.confirmForfeit'))) onForfeit();
    });
    return forfeitBtn;
  }

  function buildFuseIndicator(session) {
    session.view.fuse = createNode(
      session,
      'span',
      {
        style: {
          color: '#ffcc44',
          fontFamily: 'monospace',
          fontSize: '11px',
          padding: '2px 6px',
          borderRadius: '3px',
          background: 'rgba(255,200,50,0.1)',
          border: '1px solid rgba(255,200,50,0.3)',
          marginLeft: '4px',
          display: 'none',
        },
      },
      '',
    );
    session.view.fuse.title = translateLabel(session, 'games.worms.grenadeTimerHelp');
    return session.view.fuse;
  }

  function buildHealthList(session) {
    return createNode(session, 'div', {
      class: 'worms-healthbar',
      style: {
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px',
        background: '#0d0d0d',
        padding: '3px 8px',
        flexShrink: '0',
        fontFamily: 'monospace',
        fontSize: '11px',
      },
    });
  }
  return { mount, reset, stop, status, getView: () => current?.view ?? null };
}
