# Surf

Surf integrates a browser build of Counter-Strike: Source with the ChaOS website. It provides multiplayer rooms, verified times, replays, rankings at `/api/surf` and an administration console. The client is served at `/surf/`.

## Install

From the ChaOS website repository:

```sh
node scripts/games/games-install.mjs surf
node games/surf/install.mjs <mirror-directory>
```

The mirror must contain `index.html`, `assets/`, `packed/`, `previews/` and `brand/`. The installer copies the large client into `games/surf/data/` and generates the map and leaderboard catalogs. Restart the website after installation.

## Test

Run `npm test` from the ChaOS website repository. Tests cover rooms, verified runs, rankings, administration, HTTP responses and WebSocket relay.

## Credits

The browser client is based on [surfd.net](https://surfd.net/), created by [0yield](https://x.com/0yield). The original game is [Counter-Strike: Source](https://store.steampowered.com/app/240/CounterStrike_Source/) by [Valve](https://www.valvesoftware.com/), together with the wider modding community and the many map creators whose work makes surf gameplay possible. No Valve game files are redistributed in this Git repository.
