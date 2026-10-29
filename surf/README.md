# Surf

Surf integrates a browser build of Counter-Strike: Source with the ChaOS website. It provides multiplayer rooms, verified times, replays, rankings at `/api/surf` and an administration console. The client is served at `/surf/`.

## Install

From the ChaOS website repository:

```sh
node scripts/games-install.mjs surf
node games/surf/install.mjs <mirror-directory>
```

The mirror must contain `index.html`, `assets/`, `packed/`, `previews/` and `brand/`. The installer copies the large client into `games/surf/data/` and generates the map and leaderboard catalogs. Restart the website after installation.

## Test

Run `npm test` from the ChaOS website repository. Tests cover rooms, verified runs, rankings, administration, HTTP responses and WebSocket relay.

## Credits

The browser client and its maps come from the project mirror used by this add-on. Counter-Strike and Source are trademarks of [Valve](https://www.valvesoftware.com/). No Valve game files are redistributed in this Git repository.
