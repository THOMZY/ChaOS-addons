// Lua patches may change without changing the WASM binary. Version every core
// file so a browser cannot combine a new stamp with yesterday's engine scripts.
export function engineFileUrl(group, path, version) {
  const url = group.base + path.split('/').map(encodeURIComponent).join('/');
  return group.prefix === '' && version ? `${url}?v=${encodeURIComponent(version)}` : url;
}
