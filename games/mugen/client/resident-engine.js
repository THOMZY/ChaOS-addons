// Keep the iframe attached to the same DOM parent: moving an iframe to a new
// stage would reload its document and throw away the native asset cache.
import { createEngineFrame } from './engine-frame.js';

export function createResidentEngine({ container, scope, resources }) {
  let frame = null,
    target = null,
    lease = 0;
  let starting = Promise.resolve();
  const observer = new ResizeObserver(sync);
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  function sync() {
    if (!frame || !target) return;
    const parent = container.getBoundingClientRect(),
      stage = target.getBoundingClientRect();
    const sx = container.offsetWidth / parent.width || 1,
      sy = container.offsetHeight / parent.height || 1;
    Object.assign(frame.element.style, {
      position: 'absolute',
      left: (stage.left - parent.left) * sx - container.clientLeft + 'px',
      top: (stage.top - parent.top) * sy - container.clientTop + 'px',
      width: stage.width * sx + 'px',
      height: stage.height * sy + 'px',
      display: 'block',
    });
  }
  function reset() {
    lease++;
    observer.disconnect();
    target = null;
    frame?.destroy();
    frame = null;
  }
  scope.cleanup(reset);
  scope.on(window, 'resize', sync);
  return {
    reset,
    acquire(stage) {
      const id = ++lease;
      frame ??= createEngineFrame({ container, scope, resources });
      target = stage;
      observer.disconnect();
      observer.observe(container);
      observer.observe(stage);
      sync();
      const current = frame;
      return {
        element: current.element,
        focus: current.focus,
        setVolume: current.setVolume,
        start: async (options) => {
          await starting;
          if (id !== lease || frame !== current) throw new Error('engine_stopped');
          try {
            const pending = current.start({
              ...options,
              persistent: true,
              onExit: (outcome) => {
                if (outcome.code !== 0 && frame === current) reset();
                options.onExit?.(outcome);
              },
            });
            starting = pending.catch(() => {}); // A later lease may retry with a fresh frame after a startup failure.
            const handle = await pending;
            if (id !== lease) current.cancelMatch();
            return handle;
          } catch (error) {
            if (frame === current) reset();
            throw error;
          }
        },
        destroy() {
          if (lease !== id) return;
          target = null;
          observer.disconnect();
          current.cancelMatch();
          current.element.style.display = 'none';
        },
      };
    },
  };
}
