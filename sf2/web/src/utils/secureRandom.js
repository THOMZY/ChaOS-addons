const UINT32_RANGE = 2 ** 32;

export function randomUnit() {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return value[0] / UINT32_RANGE;
}
