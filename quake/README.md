# Quake 3

Le client Quake 3 en WebAssembly (Q3JS / ioquake3) servi sous `/quake/`, avec son cache hors ligne (service worker), l'API `/api/quake` (pseudo du joueur, état du serveur) et le tunnel WebSocket↔UDP vers le serveur natif `ioq3ded` (conteneur `quake`).

| Fichier | Rôle |
| --- | --- |
| `server/addon.js` | point d'entrée : routes `/api/quake` et `/quake/*` (page de jeu, Flight, service worker, fichiers du client) |
| `server/game.js` | déclaration du tunnel `quake3` sur le socle `games/platform/game-servers/` du site (`Q3_HOST`, `Q3_PORT`) |
| `server/api.js` | configuration du client et sonde `getstatus` du serveur |
| `server/cache-worker.js` | service worker qui garde les ressources du client hors ligne |
| `install.mjs` | installe le client (~80 Mo) dans `games/quake/data/` |

Le conteneur `quake` (image `lukaklacar/q3js-server`) est déclaré dans le `docker-compose.yml` du site sous le **profil Compose `quake`** (`addon.json` : `compose.profile`). Le déploiement l'active dès que l'add-on est installé ; en local : `COMPOSE_PROFILES=quake docker compose up -d`. Il lit `games/quake/data/baseq3/` en lecture seule, les mêmes fichiers que ceux servis au navigateur.

## Installer

```
node scripts/games-install.mjs quake                 # code de l'add-on
node games/quake/install.mjs <dossier-du-miroir>     # données, une fois
```

Le miroir contient `game2/game`, `game2/_next/`, `game2/ioquake3.*`, `game2/baseq3/`, `assets/touch-controls.js`, les icônes et `manifest.json`. Une installation d'avant J7 (`server/games/quake/` du site) est déplacée automatiquement vers `games/quake/data/`.

## Tests

`tests/*.test.js` tourne avec `npm test` du site : service worker, adaptateur du tunnel (paquet de déconnexion), contrat HTTP des fichiers du client. Banc Chromium réel (service worker, 304, WASM, plages) à lancer à la main : `node games/quake/tests/browser.mjs` (variable `BROWSER_PATH` si besoin).
