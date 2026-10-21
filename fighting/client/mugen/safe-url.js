function safeMugenUrlObject(value) {
  const url = new URL(value, window.location.origin);
  const allowedPath = url.pathname.startsWith('/mugen/')
    || url.pathname.startsWith('/mugen-stages/');
  if (
    url.origin !== window.location.origin
    || !allowedPath
    || url.username
    || url.password
  ) {
    throw new Error('Invalid MUGEN resource URL');
  }
  return url;
}

function safeMugenPath(value) {
  const url = safeMugenUrlObject(value);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function safeMugenUrl(value) {
  return safeMugenUrlObject(value);
}

function appendXhrHeaders(xhr, headers) {
  if (!headers) return;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => xhr.setRequestHeader(key, value));
    return;
  }
  if (Array.isArray(headers)) {
    headers.forEach(([key, value]) => xhr.setRequestHeader(key, value));
    return;
  }
  Object.entries(headers).forEach(([key, value]) => xhr.setRequestHeader(key, value));
}

function xhrResponseHeaders(xhr) {
  const headers = new Headers();
  xhr.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach(line => {
    if (!line) return;
    const index = line.indexOf(':');
    if (index <= 0) return;
    headers.append(line.slice(0, index).trim(), line.slice(index + 1).trim());
  });
  return headers;
}

function sameOriginMugenRequest(path, init = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(String(init.method || 'GET').toUpperCase(), path, true);
    xhr.responseType = 'arraybuffer';
    xhr.withCredentials = init.credentials === 'include';
    xhr.onload = () => {
      const body = [204, 205, 304].includes(xhr.status) ? null : xhr.response;
      resolve(new Response(body, {
        status: xhr.status,
        statusText: xhr.statusText,
        headers: xhrResponseHeaders(xhr),
      }));
    };
    xhr.onerror = () => reject(new Error('network error'));
    xhr.onabort = () => {
      const error = new Error('cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    if (init.cache === 'no-store' || init.cache === 'reload') {
      xhr.setRequestHeader('Cache-Control', 'no-cache');
    }
    appendXhrHeaders(xhr, init.headers);
    if (init.signal) {
      if (init.signal.aborted) {
        xhr.abort();
        return;
      }
      init.signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(init.body ?? null);
  });
}

export function fetchMugenResource(value, init) {
  const resourcePath = safeMugenPath(value);
  return sameOriginMugenRequest(resourcePath, init);
}

export function safeMugenFileUrl(base, fileName) {
  const directory = safeMugenUrlObject(`${base}/`);
  const normalized = String(fileName ?? '').replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    segments.length === 0
    || segments.some(segment => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error('Invalid MUGEN resource path');
  }
  const encodedPath = segments.map(segment => encodeURIComponent(decodeURIComponent(segment))).join('/');
  return safeMugenUrl(new URL(encodedPath, directory));
}
