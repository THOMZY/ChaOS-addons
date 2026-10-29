# Quake 3

Quake 3 provides a Q3JS/ioquake3 WebAssembly client at `/quake/`, an offline cache and a WebSocket-to-UDP tunnel to a native `ioq3ded` server.

## Install

From the ChaOS website repository:

```sh
node scripts/games-install.mjs quake
node games/quake/install.mjs <mirror-directory>
docker compose --profile quake up -d quake
```

The mirror must contain the client files (`game2/`, `baseq3/`, `ioquake3.*`, touch controls, icons and `manifest.json`). The installer stores them in `games/quake/data/`. The old `server/games/quake/` location is migrated once.

The native server uses the `quake` Compose profile and reads `games/quake/data/baseq3/` read-only. `Q3_HOST` and `Q3_PORT` select the tunnel target.

## Test

Run `npm test` from the ChaOS website repository. For a browser check, run `node games/quake/tests/browser.mjs`; set `BROWSER_PATH` when needed.

## Credits

Engine and server: [ioquake3](https://github.com/ioquake/ioq3). Browser technology: [QuakeJS](https://github.com/inolen/quakejs). The client mirror is installed separately because of its size and licensing.
