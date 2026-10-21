# Surf

Le client Surf (Counter-Strike: Source, recompilé pour le navigateur) servi sous `/surf/`, ses salles multijoueurs dans le processus du site, ses temps et classements (`/api/surf`), et la console du panneau d'administration.

| Fichier | Rôle |
| --- | --- |
| `server/addon.js` | point d'entrée : routes `/api/surf` et `/surf`, console d'administration, salles |
| `server/room.js` | salles sur le socle `games/platform/game-servers/core.js` (rotation des maps, votes, relais des positions) |
| `server/api.js`, `server/runs.js` | actions JSON du client, temps vérifiés, replays et classements (tables `surf_*` du schéma du site) |
| `server/admin.js` | console du panneau d'administration (carte, message, éjection, vote) |
| `server/client-adapter.js` | remplace la couche Supabase du client d'origine, injecté par l'installateur |
| `server/maps.json`, `server/boards.json` | générés par `install.mjs` à partir du miroir |
| `install.mjs` | installe le client (~850 Mo) dans `games/surf/data/` |

## Installer

```
node scripts/games-install.mjs surf               # code de l'add-on
node games/surf/install.mjs <dossier-du-miroir>   # données, une fois
```

Le miroir contient `index.html`, `assets/`, `packed/`, `previews/` et `brand/`. L'installateur est idempotent : il repart toujours du miroir. Il régénère `server/maps.json` et `server/boards.json` dans la copie installée ; si le miroir change, recopier ces deux fichiers ici.

Une installation d'avant J7 (`server/games/surf/` du site) est déplacée automatiquement vers `games/surf/data/` par `games-install.mjs`.

## Tests

`tests/` est lancé par `npm test` du site quand l'add-on est installé : salles, API, temps, console d'administration, contrat HTTP des fichiers du client et intégration complète (ticket, WebSocket, relais).
