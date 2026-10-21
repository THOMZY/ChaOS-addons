const UINT32_RANGE = 2 ** 32;

export function secureRandomFloat() {
    const buf = new Uint32Array(1);
    globalThis.crypto.getRandomValues(buf);
    return buf[0] / UINT32_RANGE;
}
