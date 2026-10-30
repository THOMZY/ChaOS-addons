// Native Ikemen replay bytes: config header, random seeds and confirmed inputs.
// Keep the complete, ordered history for late spectators. Never accept a gap.
const MAX_CHUNK = 32 * 1024;
const MAX_REPLAY = 16 * 1024 * 1024;
const MAX_PER_SECOND = 128 * 1024;

export function createReplays({ now = Date.now } = {}) {
  const rooms = new Map();
  return {
    push(roomId, { offset, data }) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Buffer.isBuffer(data) ||
        !data.length ||
        data.length > MAX_CHUNK
      )
        return null;
      let room = rooms.get(roomId);
      if (!room) {
        if (offset !== 0) return null;
        room = { chunks: [], bytes: 0, second: -1, sent: 0, invalid: false };
        rooms.set(roomId, room);
      }
      if (room.invalid) return null;
      const second = Math.floor(now() / 1000);
      if (room.second !== second) {
        room.second = second;
        room.sent = 0;
      }
      if (
        offset !== room.bytes ||
        room.bytes + data.length > MAX_REPLAY ||
        room.sent + data.length > MAX_PER_SECOND
      ) {
        room.invalid = true;
        room.chunks = [];
        return null;
      }
      const chunk = { roomId, offset, data: Buffer.from(data) };
      room.chunks.push(chunk);
      room.bytes += data.length;
      room.sent += data.length;
      return chunk;
    },
    snapshot(roomId) {
      return rooms.get(roomId)?.chunks ?? [];
    },
    invalid(roomId) {
      return rooms.get(roomId)?.invalid ?? false;
    },
    clear(roomId) {
      rooms.delete(roomId);
    },
    clearAll() {
      rooms.clear();
    },
    size() {
      return rooms.size;
    },
  };
}
