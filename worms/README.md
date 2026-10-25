# Worms

Le Worms du site (parties à plusieurs, mises, tickets) : salles, règles et minuteries côté serveur, contrôleur du navigateur et ses images et sons. Clone HTML5 de Worms Armageddon par CiaranMcCann (Apache-2.0) pour les médias. À terme remplacé par Hedgewars (`todo.txt` du site).

| Fichier | Rôle |
| --- | --- |
| `server/index.js` | point d'entrée : crochets `/chat` (salles, mises), arrêt, et route `/worms-assets` des médias |
| `server/model.js`, `server/runtime.js` | règles (terrains, armes, tours) et salles, mises, minuteries |
| `client/worms.js`, `client/style.css` | contrôleur du navigateur et style du champ de bataille, servis sous `/games/worms/client/` |
| `client/worms-media.js` | propriétaire des sprites, sons préchargés et clones audio en lecture ; construction inactive, chargement au premier affichage, arrêt terminal et ressources consultables |
| `client/worms-terrain.js` | masque de hauteurs serveur, terrain/ciel/eau/nuages, canvas intermédiaire et écouteurs de chargement possédés par manche ; reset réutilisable, stop terminal |
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

Dix-huit tests ajoutés : trois via le contrôleur public et quinze sur la factory. Les deux régressions de libération d’images échouaient avant correction. Le banc Chromium du site exerce des éléments image/audio natifs, avec les promesses de lecture pilotées et sans lecture sonore réelle dans ce scénario. Les 183 fonctions conservées et les cinq catalogues déplacés gardent leur arbre syntaxique. Ce premier lot laisse le noyau au-dessus de la cible de 800 lignes ; le lot terrain/décor ci-dessous poursuit ce chantier.


## Découpage du client — A9-worms-b (25/10/2026)

Le noyau passe de 3 149 à 2 950 lignes ; `worms-terrain.js` compte 319 lignes. Sa factory reçoit dimensions, état de terrain, images/niveaux, création de canvas, horloge et état actif. Construction inactive ; `prepare` calcule le masque depuis les hauteurs serveur et le rend au noyau physique, prépare thème/graines/nuages et possède les événements de l’image de niveau. `mount`, `redraw` et `drawBackground` dessinent sur un canvas privé. `reset` libère bitmap (dimensions mises à zéro), écouteurs et nuages entre manches ; `stop` est terminal. Les sources d’images appartiennent toujours au propriétaire des médias et ne sont pas détruites par le terrain. Un callback conservé de l’ancienne manche ne peut plus redessiner la suivante.

Les formules de ciel, étoiles, nuages, eau, cratères et remplissage sont conservées ; les PNG ne déterminent jamais les collisions. Les 166 fonctions conservées sont syntaxiquement identiques ; seuls quatre raccords de composition/cycle de vie changent. Vingt tests couvrent masque, tracés, graines numériques d’origine et libération ; deux défauts de callback/bitmap ont été reproduits dans les fonctions d’origine avant extraction. Chromium vérifie les pixels réels d’un canvas avec un PNG synthétique, le masque indépendant, les trous et l’eau, puis le changement de manche et l’arrêt. Le banc distingue les interceptions CDP annulées par preuve réseau des erreurs non expliquées.

Le noyau reste au-dessus de 800 lignes. Suite : A9-worms-c, rendu des vers, sprites et libellés ; autres dessins/effets, physique, interface/entrées et événements restent à découper.
