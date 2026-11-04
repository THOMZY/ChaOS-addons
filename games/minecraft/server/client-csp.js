// Security policy for the Minecraft client (EaglerCraftX) served under /mc/.
//
// This document is a **third-party client**: it evaluates code (asm.js/WASM), creates
// `blob:` workers, and opens a WebSocket to the site's tunnel. It therefore needs
// `'unsafe-eval'` and `blob:` — avoiding these would require rewriting the client.
// The previous policy allowed `default-src *`, which also allowed any origin for
// scripts, frames, forms, and outbound connections. A compromised client could
// exfiltrate data to an arbitrary host from an origin **identical to the site's**
// (and therefore with access to the session cookie).
//
// The policy below keeps everything the client needs for its own resources and
// tunnel while removing the wildcard: each resource type is listed explicitly.
// The installed client does not reference absolute URLs (verified in
// `web/eaglercraft.html`), and the site's `check-mc-csp-browser.mjs` verifies that it
// starts without CSP violations.
export const MC_CLIENT_CSP = [
  "default-src 'none'",
  // The client is a single inline document plus asm.js/WASM.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob: mediastream:",
  "font-src 'self' data:",
  // Tunnel WebSocket (/mc-ws) on the same origin; ws:/wss: cover explicit ports
  // and deployments behind a proxy.
  "connect-src 'self' ws: wss: data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
