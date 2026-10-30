// A seekable, growing replay file. Reads wait for complete data instead of
// returning a temporary EOF, which would make Ikemen end the replay.
export const REPLAY_PATH = 'save/chaos-live.replay';
const MAX_BYTES = 16 * 1024 * 1024;

export function createLiveReplay(files, { onProgress = () => {} } = {}) {
  files.writeText(REPLAY_PATH, '');
  const handles = new Map(),
    pending = new Set();
  let storage = new Uint8Array(4096),
    length = 0,
    ended = false,
    failed = null;
  const original = {
    open: files.fs.open,
    read: files.fs.read,
    close: files.fs.close,
  };
  files.fs.open = (path, flags, mode, callback) =>
    original.open(path, flags, mode, (error, handle) => {
      if (!error && String(path).replace(/^\//, '') === REPLAY_PATH) handles.set(handle, 0);
      callback(error, handle);
    });
  files.fs.read = (handle, buffer, offset, count, position, callback) => {
    if (!handles.has(handle))
      return original.read(handle, buffer, offset, count, position, callback);
    const start = position ?? handles.get(handle);
    const request = {
      handle,
      callback,
      run() {
        if (failed) {
          callback(failed);
          return true;
        }
        if (!ended && start + count > length) return false;
        const available = Math.max(0, Math.min(count, length - start));
        buffer.set(storage.subarray(start, start + available), offset);
        // Go uses positioned reads; retain the cursor for catch-up feedback too.
        handles.set(handle, start + available);
        onProgress({ behindBytes: Math.max(0, length - start - available) });
        callback(null, available);
        return true;
      },
    };
    if (!request.run()) pending.add(request);
  };
  files.fs.close = (handle, callback) => {
    if (handles.delete(handle))
      for (const request of [...pending]) {
        if (request.handle !== handle) continue;
        pending.delete(request);
        request.callback(Object.assign(new Error('replay_closed'), { code: 'EBADF' }));
      }
    original.close(handle, callback);
  };
  function wake() {
    // Remove before invoking callbacks: Go may synchronously issue another read.
    for (const request of [...pending]) {
      pending.delete(request);
      if (!request.run()) pending.add(request);
    }
  }
  return {
    push({ offset, data }) {
      if (ended) return;
      const bytes = new Uint8Array(data);
      if (offset !== length || !bytes.length || length + bytes.length > MAX_BYTES) {
        this.end(Object.assign(new Error('replay_gap'), { code: 'EIO' }));
        return;
      }
      if (length + bytes.length > storage.length) {
        const grown = new Uint8Array(
          Math.min(MAX_BYTES, Math.max(storage.length * 2, length + bytes.length)),
        );
        grown.set(storage.subarray(0, length));
        storage = grown;
      }
      storage.set(bytes, length);
      length += bytes.length;
      wake();
    },
    end(error = null) {
      ended = true;
      failed = error && Object.assign(error, { code: error.code ?? 'EIO' });
      wake();
    },
    dispose() {
      ended = true;
      wake();
      Object.assign(files.fs, original);
      pending.clear();
      handles.clear();
      storage = new Uint8Array(0);
    },
    speed() {
      const position = Math.max(0, ...handles.values());
      // One native replay frame is 8 controllers * 8 bytes at 60 Hz.
      return length - position > 64 * 120 ? 8 : 1;
    },
  };
}

// Batch native file writes into small socket packets. Recording runs throughout
// the match so a spectator can always replay from the initial seed.
export function createReplaySender(send, timers = globalThis) {
  let chunks = [],
    length = 0,
    offset = 0,
    timer = null,
    disposed = false;
  function flush() {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!length) return;
    const data = new Uint8Array(length);
    let at = 0;
    for (const chunk of chunks) {
      data.set(chunk, at);
      at += chunk.length;
    }
    chunks = [];
    length = 0;
    send({ offset, data });
    offset += data.length;
  }
  return {
    write(path, position, bytes) {
      if (disposed || path !== REPLAY_PATH || !bytes.length) return;
      if (position !== offset + length) throw new Error('replay_write_order');
      if (length + bytes.length > 32 * 1024) flush();
      // The Go write buffer is reused after the callback returns.
      chunks.push(new Uint8Array(bytes));
      length += bytes.length;
      if (timer === null) timer = timers.setTimeout(flush, 100);
    },
    flush,
    dispose() {
      flush();
      disposed = true;
    },
  };
}
