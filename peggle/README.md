# Peggle

Peggle sur les tables partagées du site (roadmap J5c) : chaque siège joue le même niveau dans son navigateur, le meilleur score prend le pot. Moteur et illustrations de l'add-on World of Warcraft « Peggle Classic ».

| Fichier | Rôle |
| --- | --- |
| `server/index.js` | point d'entrée : enregistre les règles de table auprès du site (`registerTableRules`, `games/platform/table-games.js`) et sert `/peggle-images` et `/peggle-sounds` |
| `server/table-rules.js` | règles de la table : niveau tiré pour tous, scores bornés et cachés jusqu'à la fin, meilleur score payé |
| `server/levels.js` | lit les niveaux de `media/levels.lua` et colore les pions |
| `client/index.js`, `client/style.css` | client de la table, servi sous `/games/peggle/client/` (désigné par la fiche du site, `games/peggle/manifest.js`) |
| `client/peggle.js`, `client/peggle-ui.js`, `client/peggle.css` | moteur (script classique), interface et style, chargés par le chargeur de ressources du site |
| `media/` | images, sons et `levels.lua` (lu seulement par le serveur, jamais publié) |

Le site garde la fiche du catalogue et les textes (`games.peggle.*`, `peggle.*`). Le site charge les add-ons avant de démarrer ses tables : sans l'add-on, la fiche reste « À installer » et aucune table Peggle ne peut être créée.

## Installer

```
node scripts/games-install.mjs peggle
```

Pas de données à part : les médias (~3 Mo) sont versionnés ici. Redémarrer le site.

## Tests

`tests/*.test.js` tourne avec `npm test` du site : règles de table, niveaux, table financée sur le socle du site, moteur et interface (via `tests/site-modules.mjs` pour les imports `/core/js/...`).
