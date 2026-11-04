import * as admin from './admin.js';
export function runCommand(command) {
  const [verb, ...rest] = command.split(/\s+/);
  const arg = rest.join(' ').trim();
  const room = admin.listRooms()[0] ?? null;
  if (!room) return { ok: false, error: 'aucune_salle' };
  const roomId = room.id;

  switch (verb.toLowerCase()) {
    case '/map': {
      if (!arg)
        return {
          ok: true,
          outputKey: 'games.console.mapList',
          outputValues: { maps: admin.MAP_ROTATION.join(', ') },
        };
      const result = admin.setMap(roomId, arg, 'console');
      return result.ok
        ? {
            ok: true,
            outputKey: 'games.console.mapSet',
            outputValues: { map: result.mapId, epoch: result.epoch },
          }
        : { ok: false, error: result.error };
    }
    case '/next': {
      const result = admin.setMap(roomId, room.mapIndex + 1, 'console');
      return result.ok
        ? {
            ok: true,
            outputKey: 'games.console.nextMap',
            outputValues: { map: result.mapId },
          }
        : { ok: false, error: result.error };
    }
    case '/vote': {
      const result = admin.openVote(roomId);
      return result.ok
        ? { ok: true, outputKey: 'games.console.voteOpened' }
        : { ok: false, error: result.error };
    }
    case '/say': {
      if (!arg) return { ok: false, error: 'message_vide' };
      const result = admin.broadcast(roomId, arg);
      return result.ok
        ? {
            ok: true,
            outputKey: 'games.console.broadcast',
            outputValues: { message: arg },
          }
        : { ok: false, error: result.error };
    }
    case '/kick': {
      const target = room.players.find((player) => player.name.toLowerCase() === arg.toLowerCase());
      if (!target) return { ok: false, error: 'joueur_absent' };
      const result = admin.kick(roomId, target.connectionId);
      return result.ok
        ? {
            ok: true,
            outputKey: 'games.console.kicked',
            outputValues: { name: result.name },
          }
        : { ok: false, error: result.error };
    }
    case '/roster': {
      const names = room.players.map((player) => `${player.name} (slot ${player.slot})`);
      return names.length
        ? { ok: true, output: names.join('\n') }
        : { ok: true, outputKey: 'games.noPlayers' };
    }
    case '/help':
      return {
        ok: true,
        output: '/map <id> · /next · /vote · /say <texte> · /kick <pseudo> · /roster',
      };
    default:
      return { ok: false, error: 'commande_inconnue' };
  }
}
