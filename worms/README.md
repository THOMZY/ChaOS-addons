# Worms

Le Worms du site (parties à plusieurs, mises, tickets) : salles, règles et minuteries côté serveur, contrôleur du navigateur et ses images et sons. Clone HTML5 de Worms Armageddon par CiaranMcCann (Apache-2.0) pour les médias. À terme remplacé par Hedgewars (`todo.txt` du site).

| Fichier | Rôle |
| --- | --- |
| `server/index.js` | point d'entrée : crochets `/chat` (salles, mises), arrêt, et route `/worms-assets` des médias |
| `server/model.js`, `server/runtime.js` | règles (terrains, armes, tours) et salles, mises, minuteries |
| `client/worms.js`, `client/style.css` | contrôleur du navigateur et style du champ de bataille, servis sous `/games/worms/client/` |
| `client/worms-media.js` | propriétaire des sprites, sons préchargés et clones audio en lecture ; construction inactive, chargement au premier affichage, arrêt terminal et ressources consultables |
| `media/` | images (niveaux, armes) et sons, servis sous `/worms-assets/` ; les niveaux sont aussi lus par le serveur |

Le site garde la fenêtre « Worms » (`website/features/worms/`), son entrée légère `website/core/js/games/worms-entry.js` (liste des événements, chargement du contrôleur à l'ouverture ou à l'admission dans une salle) et ses textes (`worms.*` dans les catalogues du site). Le contrôleur importe les modules du site par URL (`/core/js/...`).

## Installer

```
node scripts/games-install.mjs worms
```

Pas de données à part : les médias (~4 Mo) sont versionnés ici. Redémarrer le site.

## Tests

`tests/*.test.js` tourne avec `npm test` du site : règles, salles et mises, arrêt sur vrais sockets, portefeuille sur SQLite, contrôleur du navigateur (inventaire des événements partagé avec le site, propriété des écouteurs, rendu des pseudos). `tests/site-modules.mjs` fait correspondre les imports `/core/js/...` du contrôleur aux fichiers du site sous node.


## Découpage du client — A9-worms-a (25/10/2026)

Le noyau passe de 3 239 à 3 149 lignes ; `worms-media.js` compte 254 lignes. Ses dépendances (images/audio, état actif/muet, hasard et journal) sont injectables. `ensureAssets()` conserve les 60 images et 36 sons, les noms et extensions sensibles à la casse, les groupes de répliques et volumes ; rien ne charge à la construction. La lecture clone ses modèles et possède ses écouteurs de fin/erreur. Fin, refus de lecture, arrêt ou remplacement retirent les écouteurs, sources et ressources audio ; les résultats tardifs ne peuvent pas agir sur un autre propriétaire. L’arrêt annule aussi les préchargements d’images et vide les caches privés. Il ne modifie ni les sockets partagées ni les mises. Le contrôleur garde sa façade publique et ne libère les médias qu’à sa sortie définitive, pas à chaque fin de manche.

Dix-huit tests ajoutés : trois via le contrôleur public et quinze sur la factory. Les deux régressions de libération d’images échouaient avant correction. Le banc Chromium du site exerce des éléments image/audio natifs, avec les promesses de lecture pilotées et sans lecture sonore réelle dans ce scénario. Les 183 fonctions conservées et les cinq catalogues déplacés gardent leur arbre syntaxique. Le client reste au-dessus de la cible de 800 lignes : suite A9-worms-b, rendu du terrain et du décor ; physique, autres dessins, interface/entrées et événements restent à découper ensuite.
