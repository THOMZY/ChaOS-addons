/**
 * Decides whether the console keeps its network stream open.
 *
 * Closing or minimising the window must cut the stream: the game must not keep
 * running for a window nobody looks at. A background browser tab is a different
 * thing — the user still expects to *hear* the console, and Chrome only keeps
 * timers at full rate for tabs that are playing audio. So a hidden tab keeps
 * streaming; only the desktop hiding the window stops it.
 */
export function shouldStream({ closed, minimized, display, visibility, width, height }) {
  if (closed || minimized) return false;
  if (display === 'none' || visibility === 'hidden') return false;
  return width > 4 && height > 4;
}
