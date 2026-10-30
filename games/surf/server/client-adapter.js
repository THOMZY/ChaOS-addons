// ChaOS — Supabase SDK surrogate for the Surf client.
//
// WHY. The Surf client dynamically imports an embedded Supabase SDK
// (`assets/index-<hash>.js`) and uses it for only two things: checking whether
// a session exists and uploading a replay to signed storage. Everything else —
// profiles, attempts, submissions, and leaderboards — already goes through
// `/api/surf`. Since this SDK has no server here, the client thinks it is signed
// out, displays "local", and saves nothing on the server.
//
// THIS FILE REPLACES IT during installation (`games/surf/install.mjs` writes
// over `assets/index-<hash>.js`). It is not a fake Supabase implementation; it
// is an adapter and makes no such claim. It exposes exactly the API surface
// used by the client:
//
//   createClient(url, key, options) -> {
//     auth:    onAuthStateChange, getSession, refreshSession,
//              signInWithOAuth, signOut
//     storage: from(bucket).uploadToSignedUrl(path, token, blob, options)
//   }
//
// Identity comes from the ChaOS ACCOUNT, not a Supabase account. It is read from
// the session cookie by `GET /api/auth/me`. Since the game is served from the
// same origin as the site, the browser sends the cookie automatically.

// Use the same endpoint as the ChaOS desktop so there is a single source of
// truth for session-cookie validity. This path is absolute because the module
// runs inside the `/surf/` iframe.
const SESSION_URL = '/api/auth/me';

/** Build a client-compatible session from a ChaOS account. */
function sessionFrom(account) {
  if (!account || !account.id) return null;
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: 'chaos-account',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: 'chaos-account',
    user: {
      id: account.id,
      email: null,
      phone: '',
      role: 'authenticated',
      aud: 'authenticated',
      app_metadata: { provider: 'chaos', providers: ['chaos'] },
      user_metadata: { chaos_surf_signup_username: account.pseudo ?? undefined },
      created_at: account.createdAt ? new Date(account.createdAt).toISOString() : new Date().toISOString(),
    },
  };
}

async function readSession() {
  try {
    const response = await fetch(SESSION_URL, { credentials: 'include', cache: 'no-store' });
    if (!response.ok) return null;
    return sessionFrom((await response.json()).account);
  } catch (_) {
    return null;   // If the site is unreachable, the client falls back to local play.
  }
}

export function createClient(_url, _key, _options = {}) {
  const subscribers = new Set();
  let session = null;
  let firstRead = null;

  const notify = (event) => {
    for (const callback of subscribers) {
      try { callback(event, session); } catch (_) { /* The client handles callback errors. */ }
    }
  };

  const loadSession = () => {
    if (!firstRead) {
      firstRead = readSession().then((loadedSession) => {
        session = loadedSession;
        return loadedSession;
      });
    }
    return firstRead;
  };

  const auth = {
    /** The client expects { data: { subscription } }; it only uses the callback. */
    onAuthStateChange(cb) {
      subscribers.add(cb);
      // Notify a new subscriber as soon as the session is known, or it would
      // remain signed out until the next action.
      loadSession().then(() => {
        if (subscribers.has(cb)) { try { cb(session ? 'SIGNED_IN' : 'SIGNED_OUT', session); } catch (_) { /* one subscriber must not break the others */ } }
      });
      return { data: { subscription: { unsubscribe() { subscribers.delete(cb); } } } };
    },

    async getSession() {
      await loadSession();
      return { data: { session }, error: null };
    },

    async refreshSession() {
      session = await readSession();
      return { data: { session }, error: null };
    },

    /**
     * There is no OAuth provider here: the user is already signed in to the site,
     * and the client panel is hidden during installation. Reload the session
     * instead of introducing a redirect.
     */
    async signInWithOAuth() {
      session = await readSession();
      notify(session ? 'SIGNED_IN' : 'SIGNED_OUT');
      return { data: { provider: 'chaos', url: null }, error: null };
    },

    /**
     * Signing out of THE GAME does not sign the user out of the site: the ChaOS
     * session remains valid and identity returns on the next load. Notify the
     * client without touching the site's cookies.
     */
    async signOut() {
      session = null;
      firstRead = Promise.resolve(null);
      notify('SIGNED_OUT');
      return { error: null };
    },
  };

  const storage = {
      from(_bucket) {
      return {
        /**
         * The client calls this after an "issued" response. The target path is
         * our same-origin API; keep the gzip blob unchanged so friends can replay
         * the best time from the leaderboard.
         */
        async uploadToSignedUrl(path, _token, blob, options = {}) {
          try {
            const response = await fetch(path, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': options.contentType || 'application/gzip' },
              body: blob,
            });
            if (!response.ok) return { data: null, error: new Error(`Replay upload failed (${response.status})`) };
            return { data: { path }, error: null };
          } catch (error) {
            return { data: null, error };
          }
        },
      };
    },
  };

  return { auth, storage };
}

export default { createClient };
