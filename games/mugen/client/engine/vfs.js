// The file system Ikemen GO sees in the browser. Go's js/wasm runtime calls a
// Node-style callback API on globalThis.fs (syscall/fs_js.go); this implements
// it over the add-on's HTTP routes:
//   - the manifest (/api/mugen/fs) lists every readable file and its URL;
//   - a file is downloaded the first time the engine opens it;
//   - writes (config, logs, stats) stay in memory for this match only.
// Paths are matched without regard to case: MUGEN packs are authored on
// Windows and their .def files rarely agree with the file names on disk.

import { engineFileUrl } from './file-url.js';

const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const O_WRONLY = 1;
const O_RDWR = 2;
const O_CREAT = 0o100;
const O_EXCL = 0o200;
const O_TRUNC = 0o1000;
const O_APPEND = 0o2000;
const O_DIRECTORY = 0o200000;
// Sprite sheets are decoded by the engine and not read again: keeping their
// bytes after close would double their memory for nothing.
const RELEASE_AFTER_CLOSE_BYTES = 2 * 1024 * 1024;

function failure(code, path = '') {
  const error = new Error(`${code}: ${path}`);
  error.code = code;
  return error;
}

export function normalizePath(path) {
  const parts = [];
  for (const part of String(path).replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

/**
 * @param {object} manifest the /api/mugen/fs answer
 * @param {object} [options]
 * @param {(url: string) => Promise<Response>} [options.fetchFile]
 * @param {(line: string, isError: boolean) => void} [options.log]
 */
export function createBrowserFileSystem(
  manifest,
  { fetchFile = (url) => fetch(url), log = () => {}, onWrite = () => {} } = {},
) {
  const remote = new Map(); // path -> { url, size }
  const contents = new Map(); // path -> Uint8Array (downloaded or written)
  const capacities = new Map(); // amortized growth for replay files
  const written = new Set();
  const directories = new Set(['']);
  const byLowerCase = new Map(); // lower-case path -> path
  const downloads = new Map();
  const handles = new Map();
  let nextHandle = 3;

  function indexDirectories(path, includeLast) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length - (includeLast ? 0 : 1); i++) {
      const directory = parts.slice(0, i).join('/');
      directories.add(directory);
      byLowerCase.set(directory.toLowerCase(), directory);
    }
  }
  function index(path) {
    byLowerCase.set(path.toLowerCase(), path);
    indexDirectories(path, false);
  }
  function mount(next) {
    for (const group of next.groups ?? []) {
      for (const [relative, size] of group.files ?? []) {
        const path = normalizePath(group.prefix + relative);
        remote.set(path, { url: engineFileUrl(group, relative, next.engine?.version), size });
        index(path);
      }
    }
    for (const [relative, text] of Object.entries(next.generated ?? {})) {
      const path = normalizePath(relative);
      contents.set(
        path,
        typeof text === 'string'
          ? new TextEncoder().encode(text)
          : Uint8Array.from(atob(text.base64), (value) => value.charCodeAt(0)),
      );
      remote.delete(path);
      index(path);
    }
  }
  mount(manifest);

  const resolve = (raw) => {
    const path = normalizePath(raw);
    if (contents.has(path) || remote.has(path) || directories.has(path)) return path;
    return byLowerCase.get(path.toLowerCase()) ?? path;
  };
  const isFile = (path) => contents.has(path) || remote.has(path);
  const sizeOf = (path) => contents.get(path)?.length ?? remote.get(path)?.size ?? 0;

  function stat(path) {
    const directory = !isFile(path);
    const size = directory ? 0 : sizeOf(path);
    const time = 0;
    return {
      dev: 1,
      ino: 1,
      mode: directory ? S_IFDIR | 0o755 : S_IFREG | 0o644,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: time,
      mtimeMs: time,
      ctimeMs: time,
      isDirectory: () => directory,
    };
  }

  function download(path) {
    if (contents.has(path)) return Promise.resolve(contents.get(path));
    if (downloads.has(path)) return downloads.get(path);
    const entry = remote.get(path);
    const pending = fetchFile(entry.url)
      .then(async (response) => {
        if (!response.ok) throw failure('ENOENT', path);
        const bytes = new Uint8Array(await response.arrayBuffer());
        contents.set(path, bytes);
        return bytes;
      })
      .finally(() => downloads.delete(path));
    downloads.set(path, pending);
    return pending;
  }

  function writeTo(path, data) {
    if (capacities.get(path)?.buffer !== data.buffer) capacities.delete(path);
    contents.set(path, data);
    written.add(path);
    remote.delete(path);
    index(path);
  }

  let console1 = '',
    console2 = '';
  const decoder = new TextDecoder();
  function writeConsole(handle, bytes) {
    const text = (handle === 1 ? console1 : console2) + decoder.decode(bytes);
    const lines = text.split('\n');
    const rest = lines.pop();
    for (const line of lines) log(line, handle === 2);
    if (handle === 1) console1 = rest;
    else console2 = rest;
  }

  const fs = {
    constants: {
      O_WRONLY,
      O_RDWR,
      O_CREAT,
      O_TRUNC,
      O_APPEND,
      O_EXCL,
      O_DIRECTORY,
    },
    writeSync(handle, bytes) {
      writeConsole(handle, bytes);
      return bytes.length;
    },
    open(raw, flags, _mode, callback) {
      const path = resolve(raw);
      const creating = (flags & O_CREAT) !== 0;
      const exists = isFile(path) || directories.has(path);
      if (!exists && !creating) return callback(failure('ENOENT', path));
      if (exists && creating && flags & O_EXCL) return callback(failure('EEXIST', path));
      const register = () => {
        const handle = nextHandle++;
        handles.set(handle, {
          path,
          flags,
          position: 0,
          directory: directories.has(path) && !isFile(path),
        });
        callback(null, handle);
      };
      if (directories.has(path) && !isFile(path)) return register();
      if (!isFile(path) || flags & O_TRUNC) {
        writeTo(path, new Uint8Array(0));
        return register();
      }
      download(path).then(register, (error) => callback(error));
    },
    close(handle, callback) {
      const open = handles.get(handle);
      if (!open) return callback(failure('EBADF'));
      handles.delete(handle);
      const stillOpen = [...handles.values()].some((other) => other.path === open.path);
      if (
        !stillOpen &&
        !written.has(open.path) &&
        remote.has(open.path) &&
        sizeOf(open.path) > RELEASE_AFTER_CLOSE_BYTES
      )
        contents.delete(open.path);
      callback(null);
    },
    read(handle, buffer, offset, length, position, callback) {
      const open = handles.get(handle);
      if (!open) return callback(failure('EBADF'));
      const data = contents.get(open.path);
      if (!data) return callback(failure('EIO', open.path));
      const start = position ?? open.position;
      const count = Math.max(0, Math.min(length, data.length - start));
      if (count > 0) buffer.set(data.subarray(start, start + count), offset);
      if (position === null || position === undefined) open.position = start + count;
      callback(null, count);
    },
    write(handle, buffer, offset, length, position, callback) {
      const bytes = buffer.subarray(offset, offset + length);
      if (handle === 1 || handle === 2) {
        writeConsole(handle, bytes);
        return callback(null, length);
      }
      const open = handles.get(handle);
      if (!open) return callback(failure('EBADF'));
      let data = contents.get(open.path) ?? new Uint8Array(0);
      const start = open.flags & O_APPEND ? data.length : (position ?? open.position);
      if (start + length > data.length) {
        let capacity = capacities.get(open.path);
        if (!capacity || capacity.length < start + length) {
          capacity = new Uint8Array(Math.max(start + length, (capacity?.length ?? 2048) * 2));
          capacity.set(data);
          capacities.set(open.path, capacity);
        }
        data = capacity.subarray(0, start + length);
      }
      data.set(bytes, start);
      writeTo(open.path, data);
      onWrite(open.path, start, bytes);
      if (position === null || position === undefined) open.position = start + length;
      callback(null, length);
    },
    fstat(handle, callback) {
      const open = handles.get(handle);
      if (!open) return callback(failure('EBADF'));
      callback(null, stat(open.path));
    },
    stat(raw, callback) {
      const path = resolve(raw);
      if (!isFile(path) && !directories.has(path)) return callback(failure('ENOENT', path));
      callback(null, stat(path));
    },
    lstat(raw, callback) {
      fs.stat(raw, callback);
    },
    readdir(raw, callback) {
      const path = resolve(raw);
      if (!directories.has(path) || isFile(path)) return callback(failure('ENOTDIR', path));
      const prefix = path ? path + '/' : '';
      const names = new Set();
      const collect = (candidate) => {
        if (candidate.startsWith(prefix) && candidate.length > prefix.length)
          names.add(candidate.slice(prefix.length).split('/')[0]);
      };
      for (const candidate of remote.keys()) collect(candidate);
      for (const candidate of contents.keys()) collect(candidate);
      for (const candidate of directories) collect(candidate);
      callback(null, [...names]);
    },
    mkdir(raw, _mode, callback) {
      indexDirectories(normalizePath(raw), true);
      callback(null);
    },
    rmdir(raw, callback) {
      directories.delete(resolve(raw));
      callback(null);
    },
    unlink(raw, callback) {
      const path = resolve(raw);
      if (!isFile(path)) return callback(failure('ENOENT', path));
      contents.delete(path);
      remote.delete(path);
      written.delete(path);
      callback(null);
    },
    rename(rawFrom, rawTo, callback) {
      const from = resolve(rawFrom),
        to = normalizePath(rawTo);
      if (!isFile(from)) return callback(failure('ENOENT', from));
      download(from).then((data) => {
        contents.delete(from);
        remote.delete(from);
        written.delete(from);
        writeTo(to, data);
        callback(null);
      }, callback);
    },
    truncate(raw, length, callback) {
      const path = resolve(raw);
      if (!isFile(path)) return callback(failure('ENOENT', path));
      download(path).then((data) => {
        const next = new Uint8Array(length);
        next.set(data.subarray(0, Math.min(length, data.length)));
        writeTo(path, next);
        callback(null);
      }, callback);
    },
    ftruncate(handle, length, callback) {
      const open = handles.get(handle);
      if (!open) return callback(failure('EBADF'));
      fs.truncate(open.path, length, callback);
    },
    fsync: (_handle, callback) => callback(null),
    utimes: (_path, _atime, _mtime, callback) => callback(null),
    chmod: (_path, _mode, callback) => callback(null),
    fchmod: (_handle, _mode, callback) => callback(null),
    chown: (_path, _uid, _gid, callback) => callback(null),
    fchown: (_handle, _uid, _gid, callback) => callback(null),
    lchown: (_path, _uid, _gid, callback) => callback(null),
    link: (_path, _link, callback) => callback(failure('ENOSYS')),
    symlink: (_path, _link, callback) => callback(failure('ENOSYS')),
    readlink: (_path, callback) => callback(failure('ENOSYS')),
  };

  let workingDirectory = '/';
  const process = {
    getuid: () => 0,
    getgid: () => 0,
    geteuid: () => 0,
    getegid: () => 0,
    getgroups: () => [0],
    pid: 1,
    ppid: 0,
    umask: () => 0o22,
    cwd: () => workingDirectory,
    chdir(directory) {
      workingDirectory = '/' + normalizePath(directory);
    },
  };
  const path = {
    resolve: (...segments) => '/' + normalizePath(segments.filter(Boolean).join('/')),
  };

  return {
    mount,
    fs,
    process,
    path,
    /** A file the engine wrote, as text, or null. */
    readText(raw) {
      const data = contents.get(resolve(raw));
      return data ? decoder.decode(data) : null;
    },
    writeText(raw, text) {
      writeTo(normalizePath(raw), new TextEncoder().encode(text));
    },
    has: (raw) => isFile(resolve(raw)),
  };
}
