# ChaOS-games

Les **add-ons** de [ChaOS](https://github.com/THOMZY/THOMZY.com) : les gros jeux, avec leurs installateurs et leurs tests, gardés hors du dépôt du site (roadmap J7). Le site démarre sans eux et les montre « À installer » dans le menu « Jeux ».

## Ce qu'un add-on contient

Un dossier par jeu, au nom de son id dans le site :

```
<id>/
  addon.json      description du paquet (voir plus bas)
  README.md       ce qu'il faut savoir pour l'installer et le mettre à jour
  server/         code serveur ; server/addon.js est son point d'entrée
  tests/          tests node:test, lancés par le `npm test` du site une fois installé
  install.mjs     installateur des données (gros fichiers jamais versionnés)
  client/         code du navigateur, servi sous /games/<id>/client/ (Worms)
  media/          petits médias versionnés, servis par le serveur de l'add-on (Worms)
```

Le site garde de son côté ce qui le relie au jeu : la fiche du catalogue (`games/<id>/manifest.js` et sa vignette `games/<id>/assets/`), la fenêtre et ses textes. Un add-on ne doit donc **jamais** contenir `manifest.js`, `assets/` ni son dossier de données : l'installateur refuse le paquet.

### `addon.json`

```json
{
  "id": "surf",
  "name": "Surf",
  "version": "1.0.0",
  "chaosAddonApi": 1,
  "server": "server/addon.js",
  "data": {
    "dir": "data",
    "check": "index.html",
    "legacyDir": "server/games/surf",
    "install": "node games/surf/install.mjs <dossier-du-miroir>"
  }
}
```

| Champ | Rôle |
| --- | --- |
| `id` | id du jeu dans le site (`games/<id>/`) ; doit figurer dans `KNOWN_ADDONS` (`games/addons.js` du site) |
| `version` | version de l'add-on, affichée par l'installateur |
| `chaosAddonApi` | contrat entre le site et ses add-ons ; le site refuse de démarrer avec un add-on écrit pour un autre contrat |
| `server` | module qui exporte par défaut une fonctionnalité `defineFeature({ id, routes, … })` du site |
| `data.dir` | dossier des données installées, dans `games/<id>/` ; ni copié, ni supprimé par l'installateur du site |
| `data.check` | fichier qui prouve que les données sont installées (le catalogue s'en sert pour « À installer ») |
| `data.legacyDir` | ancien emplacement des données dans le site, déplacé une seule fois vers `games/<id>/<data.dir>` |
| `data.install` | commande à lancer, depuis le site, pour installer les données |
| `compose.profile` | profil Compose du service propre au jeu (Quake : `quake`), activé par le déploiement quand l'add-on est installé |

`node scripts/check-addons.mjs` vérifie ces règles sur tous les add-ons de ce dépôt, sans le site.

### Code serveur

Une fois installé, le code vit dans `games/<id>/` du site et importe le site par chemins relatifs (`../../../server/…`, `../../platform/…`), comme les jeux intégrés. Contrat `chaosAddonApi: 1` :

- `server/addon.js` exporte par défaut `defineFeature` (`server/core/features.js`) ; `routes(app, { apiLimiter })` est appelé avant le repli de la SPA ;
- un jeu en salles s'enregistre auprès de `games/platform/game-servers/core.js` en important son module de salles ;
- une console d'administration en processus s'enregistre par `registerInProcessAdmin(id, admin)` (`games/platform/game-admin/registry.js`).
- le code du navigateur (`client/`) est servi par le catalogue du site sous `/games/<id>/client/` et importe les modules du site par URL (`/core/js/...`) ; la fenêtre, son entrée légère et les textes restent dans le site.

## Installer un add-on dans le site

Depuis le dossier du site, ce dépôt cloné à côté (`../ChaOS-games`, sinon `--from <dossier>` ou `CHAOS_GAMES_DIR`) :

```
node scripts/games-install.mjs              # état des add-ons connus
node scripts/games-install.mjs surf         # installe ou met à jour le code de Surf
node scripts/games-install.mjs --remove surf  # retire le code, garde les données
```

Puis, la première fois, les données (voir le README de l'add-on). Redémarrer le site.

**Production** : le déploiement du site récupère ce dépôt au commit noté dans `games/addons.lock.json` du site et installe les add-ons listés avant de construire l'image. Les données restent sur le VPS, montées en lecture seule (`./games/<id>/data`). Pour publier une nouvelle version d'un add-on : commit ici, push, puis mettre à jour `ref` dans le fichier de verrouillage du site.

## Add-ons

| Add-on | État |
| --- | --- |
| [Surf](surf/README.md) | prêt (J7a) |
| [Quake 3](quake/README.md) | prêt (J7b) |
| Minecraft | à déplacer (J7c) |
| [Worms](worms/README.md) | prêt (J7d) |
| Peggle | à déplacer (J7e) |
| Fighting / MUGEN, SF2 | projet Fighting / MUGEN (J8) |
