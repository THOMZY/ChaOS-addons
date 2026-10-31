export function installNativeGamepad() {
  const frame = document.querySelector('iframe').contentWindow;
  frame.testGamepad = {
    id: 'ChaOS test controller',
    index: 0,
    connected: true,
    mapping: 'standard',
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
  };
  Object.defineProperty(frame.navigator, 'getGamepads', {
    configurable: true,
    value: () => [frame.testGamepad],
  });
}

export async function readConfirmedPadInputs() {
  const frame = document.querySelector('iframe').contentWindow;
  const call = (method, ...args) =>
    new Promise((resolve, reject) =>
      frame.fs[method](...args, (error, value) => (error ? reject(error) : resolve(value))),
    );
  const handle = await call('open', 'save/chaos-live.replay', 0, 0);
  const { size } = await call('fstat', handle);
  const bytes = new Uint8Array(size);
  await call('read', handle, bytes, 0, size, 0);
  await call('close', handle);
  const marker = new TextEncoder().encode('IKRPLSYN');
  let start = -1;
  for (let index = 0; index <= bytes.length - marker.length; index++) {
    if (marker.every((value, offset) => bytes[index + offset] === value)) start = index + 16;
  }
  if (start < 0 || bytes.length < start + 64) return null;
  const offset = start + (Math.floor((bytes.length - start) / 64) - 1) * 64;
  const view = new DataView(bytes.buffer);
  return [view.getUint16(offset, true), view.getUint16(offset + 8, true)];
}
