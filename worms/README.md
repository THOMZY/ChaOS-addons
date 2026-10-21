# Worms

Le Worms du site (parties à plusieurs, mises, tickets) : salles, règles et minuteries côté serveur, contrôleur du navigateur et ses images et sons. Clone HTML5 de Worms Armageddon par CiaranMcCann (Apache-2.0) pour les médias. À terme remplacé par Hedgewars (`todo.txt` du site).

| Fichier | Rôle |
| --- | --- |
| `server/index.js` | point d'entrée : crochets `/chat` (salles, mises), arrêt, et route `/worms-assets` des médias |
| `server/model.js`, `server/runtime.js` | règles (terrains, armes, tours) et salles, mises, minuteries |
| `client/worms.js`, `client/style.css` | contrôleur du navigateur et style du champ de bataille, servis sous `/games/worms/client/` |
| `media/` | images (niveaux, armes) et sons, servis sous `/worms-assets/` ; les niveaux sont aussi lus par le serveur |

Le site garde la fenêtre « Worms » (`website/features/worms/`), son entrée légère `website/core/js/games/worms-entry.js` (liste des événements, chargement du contrôleur à l'ouverture ou à l'admission dans une salle) et ses textes (`worms.*` dans les catalogues du site). Le contrôleur importe les modules du site par URL (`/core/js/...`).

## Installer

```
node scripts/games-install.mjs worms
```

Pas de données à part : les médias (~4 Mo) sont versionnés ici. Redémarrer le site.

## Tests

`tests/*.test.js` tourne avec `npm test` du site : règles, salles et mises, arrêt sur vrais sockets, portefeuille sur SQLite, contrôleur du navigateur (inventaire des événements partagé avec le site, propriété des écouteurs, rendu des pseudos). `tests/site-modules.mjs` fait correspondre les imports `/core/js/...` du contrôleur aux fichiers du site sous node.
