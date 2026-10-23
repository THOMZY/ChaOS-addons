# Hammerfest

Le Hammerfest corrigé (build Eternalfest 2.5.2) dans une fenêtre de ChaOS, avec les comptes du site :
parties, inventaire, missions et historique vivent dans la base THOMZY.

## Ce que contient l'add-on

| Chemin | Rôle |
| --- | --- |
| `addon.json` | description du paquet (contrat `chaosAddonApi: 1`) |
| `schema.sql` | tables `hammerfest_runs`, `hammerfest_items`, `hammerfest_quests` |
| `server/build.js` | le manifeste du jeu servi au loader + la table des blobs |
| `server/build.json` | le build réel (9 modes, familles, traductions), ids de blobs réécrits |
| `server/store.js` | accès SQLite (parties, inventaire, missions) |
| `server/index.js` | l'API du loader et les routes du site |
| `client/` | la page hôte (Ruffle + loader) |
| `install.mjs` | installe les données dans `games/hammerfest/data/` |

## Données (jamais versionnées)

L'add-on ne contient **pas** le jeu : ~6,6 Mo de SWF et de XML installés par `install.mjs`.

Il faut 7 fichiers dans un dossier source :

```
game.swf            le jeu (build 2.5.2)
patchman.swf        le patcher appliqué par le loader
content.xml         niveaux, objets, quêtes
locales.fr-FR.xml   traductions
locales.en-US.xml
locales.es-SP.xml
loader.swf          le pont jeu ↔ page (5.1.2)
```

Installation :

```
node scripts/games-install.mjs hammerfest
node games/hammerfest/install.mjs <dossier-source>
```

`data.check` vaut `game.swf` : sans ce fichier, le catalogue affiche « À installer ».

## Comment le loader trouve le serveur

Le loader déduit l'URL de l'API de **sa propre origine** (`loader._url` → `origin + /api/v1`).
Servi depuis `/hammerfest/data/loader.swf`, il interroge donc THOMZY.com : aucune configuration.

## API

Compatibilité loader (formes imposées par `loader 5.1.2`) :

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `GET` | `/api/v1/games/:id` | manifeste + build |
| `GET` | `/api/v1/blobs/:id/raw` | moteur, patcher, contenu, traductions |
| `POST` | `/api/v1/runs` | la page crée la partie |
| `POST` | `/api/v1/runs/:id/start` | renvoie `families`, `items` (le frigo), `key` |
| `PUT` | `/api/v1/runs/:id/result` | reçoit le résultat brut |

Site :

| Méthode | Chemin | Rôle |
| --- | --- | --- |
| `GET` | `/api/v1/hammerfest/profile` | inventaire nommé, quêtes avec progression, stats, historique |

Tout est authentifié par la session du site (`accountFromHeaders`), **sauf** les deux appels que le
loader Flash fait depuis le film : `POST /api/v1/runs/:id/start` et `PUT /api/v1/runs/:id/result`.
L'UUID de partie y sert de capacité (même modèle qu'Eternalfest), et la route est déclarée publique
dans `server/http/api-authorization.js` du site.

## Client

| Fichier | Rôle |
| --- | --- |
| `client/play.html` + `play.js` | lanceur : carte du jeu, mode de jeu, paramètres, options du mode, puis la partie en plein cadre |
| `client/profile.html` + `profile.js` | « Frigo » (fiche Hammerfest : stats + tous les objets avec leur quantité), « Mes objets » (par famille) et « Mes quêtes » |
| `client/hf.css` | feuille de style commune |
| `client/items/{id}.png` | 357 icônes d'objets (393 Ko) |

L'interface reprend celle du site Eternalfest **d'après leur CSS global** (récupéré sur
`eternalfest.net/fr-FR/styles-*.css`), plus les styles de leurs composants (`item-table`,
`quest`, `run`) :

- conteneur `#ebd9e6` bordé de `#c52f36`, `body` en Trebuchet MS 10pt ;
- `h1` 18pt, **normal, aligné à droite**, souligné de 1px `#8f201e` ;
- onglets `.game-tabs` en forme d'onglet (`#e8b0b3`, coin arrondi en haut), l'onglet courant à plat
  et les autres en dégradé (`.blurred`) ;
- **tableaux bordés** `#6a100e`, en-têtes sur `#e8b0b3`, cellules centrées à 4px (quêtes) ;
- frigo : grille dense de 26×36, quantité 9px avec contour blanc, `?` pour un objet inconnu ;
- « Mes objets » : trois compteurs, une famille par bloc (460px, en-tête `(x / y)`), lignes
  `30px 60px 1fr` avec `xN` en rose ;
- résultats : 4 boîtes de synthèse, objets avec badges, quêtes avec barre de progression.

L'onglet « Classement » est présent (comme chez eux) mais désactivé tant que le leaderboard n'existe
pas. Les icônes d'objets sont les PNG du jeu (mêmes assets que le frigo, © Motion Twin), un objet non
possédé est grisé et translucide.

## Catalogue

`catalog/catalog.json` (36 Ko, généré depuis `hammerfest-db`) : 357 objets avec leur nom français,
leur famille et leur rareté, 52 familles, 76 quêtes avec titre, texte et prérequis. C'est la seule
source des libellés : ni le client ni le serveur n'inventent un nom d'objet.

## Inventaire

Le résultat d'une partie (`items`) est fusionné dans `hammerfest_items` avec un `MAX(quantity, ...)`
— un objet Hammerfest se possède une fois et ne se perd pas, donc rejouer une partie ne duplique
rien. L'inventaire est ensuite renvoyé au jeu dans `RunStart.items` : c'est ce qui alimente le frigo
et les quêtes **à l'intérieur du jeu**, sans code supplémentaire.

Un objet est **débloqué** quand sa quantité atteint son seuil `unlock` (10 exemplaires pour la
plupart, 1 pour les objets uniques, quelques exceptions à 3 ou 5 — valeurs lues dans
`hammerfest-db`). En dessous du seuil il reste « découvert mais verrouillé » : icône grisée.

**Écart assumé avec Eternalfest** : leur site masque le nom d'un objet non débloqué derrière
« ??? ». Ici les onglets « Mes objets » et « Mes quêtes » affichent toujours le vrai nom ; seul le
frigo garde `?` pour un objet jamais obtenu (c'est un choix de cette page).

## Classement

`client/leaderboard.html` + `GET /api/v1/hammerfest/leaderboard` (public) : pour chaque mode, le
**meilleur score de chaque joueur** (fenêtre SQL `ROW_NUMBER() OVER (PARTITION BY mode, compte)`),
du plus haut au plus bas. Les parties `abandoned` sont exclues. La ligne du joueur connecté est
surlignée.

## Page de résultat
`/runs/{id}` (là où le loader navigue en fin de partie) sert `client/result.html`. À la fin de la
partie, **avant** la fusion dans l'inventaire, `computeHighlights()` calcule et stocke dans
`hammerfest_runs.highlights` :

- les **objets ramassés** : quantité gagnée, total avant/après, seuil, `isNew` (premier exemplaire)
  et `unlockedNow` (le seuil vient d'être franchi) ;
- les **quêtes qui ont progressé** : avant → après, requis, `completedNow`.

La page affiche le score total, le niveau atteint (boîte dorée en cas de victoire), le mode, la date,
la liste des objets avec les badges « Nouveau » / « Débloqué » et les quêtes avec leur barre de
progression et le badge « Quête terminée ».

## Musiques

Le build référence six pistes mp3 (3,2 Mo) dans `build.musics`. Sans ces entrées le loader n'en
précharge aucune et `$music=1` reste sans effet : case « Musique » cochée mais silence. Les fichiers
sont servis comme les autres blobs (`GET /api/v1/blobs/{id}/raw`, `audio/mp3`), donc
`games/hammerfest/data/musics/` fait partie de l'installation (~10 Mo de données au total).

## Ce que le loader attend vraiment

| Appel | Méthode / corps |
| --- | --- |
| `POST /api/v1/runs/{id}/start` | `POST`, corps ignoré (le loader envoie `key=0000`) |
| `POST /api/v1/runs/{id}/result` | `POST` **form-urlencoded** dont chaque valeur est une chaîne JSON (`items=%7B...%7D`) |

La réponse de `start` porte aussi les **familles débloquées** du compte (`families`) : c'est la base
du build, plus les familles offertes par les quêtes terminées, moins celles qu'elles retirent
(`unlockedFamilies()`). Avec une liste figée, le jeu considère tout comme verrouillé et affiche
« ??? » à la place des descriptions de quêtes, même pour une quête terminée.

`install.mjs` neutralise aussi le mode debug du loader : il passe en console de debug dès que sa
propre URL est sur `localhost` (`Main.IS_DEBUG = hostname == "localhost"`), ce qui remplaçait la page
de fin de partie par un dump brut. Le littéral `localhost` est réécrit en `l0calho5t` dans le corps
compressé du SWF (même longueur, en-tête intact), donc une installation locale se comporte comme la
production.

## Crédits

Hammerfest © Motion Twin. Corrections et contenu : Eternalfest. Lecteur Flash : Ruffle.
Version non officielle hébergée sur THOMZY.com. Composants AGPL : loader, `hammerfest-db`.
