# ChaOS-addons

Add-ons for the ChaOS website, grouped by kind: games in `games/`, and later applications in `applications/`. Each add-on contains the code, browser client, optional media and tests for one game or application. Chaque paquet possède son catalogue, ses fenêtres, ses traductions, ses ressources et son intégration serveur. Le site fournit les comptes et les API communes.

## Games

| Add-on | What it provides |
| --- | --- |
| [Surf](games/surf/README.md) | Multiplayer surf rooms, times and rankings |
| [Quake 3](games/quake/README.md) | WebAssembly client and native server tunnel |
| [Minecraft](games/minecraft/README.md) | EaglerCraft client and Minecraft server container |
| [Worms](games/worms/README.md) | Multiplayer Worms rooms and browser game |
| [Peggle](games/peggle/README.md) | Shared Peggle tables and scoring |
| [MUGEN](games/mugen/README.md) | Ikemen GO (WebAssembly) duels, training and MUGEN packs |
| [Street Fighter II](games/sf2/README.md) | Standalone browser fighting game |
| [Hammerfest](games/hammerfest/README.md) | Eternalfest client, inventory and quests |
| [Game Boy](games/gameboy/README.md) | Shared mGBA console and cartridge library |

## Install an add-on

From the ChaOS website repository, with this repository checked out beside it as `../ChaOS-addons`:

```sh
node scripts/games/games-install.mjs surf
```

Some games need a separate data install. Follow that game's README, then restart the ChaOS website. Use `--from <directory>` when this repository is elsewhere. Installed data stays in `games/<id>/data/` and is not stored in this repository.

## Add-on structure

```text
games/<id>/
  addon.json      package metadata
  README.md       game guide
  server/         server integration
  client/         browser code
  media/          optional bundled media
  tests/          tests run by the website
  install.mjs     optional data installer
```

The website owns each game's catalog manifest, thumbnail, window and translations. Add-ons must not include those website files or an installed data directory.

## Development

Check package metadata from this repository:

```sh
node scripts/check-addons.mjs
```

Run game tests with `npm test` from the ChaOS website repository after installing the relevant add-on.

## Credits

ChaOS-addons is an integration project. Individual game credits and source links are listed in each add-on README. The ChaOS website is the host platform.

## Intégration autonome

Le manifeste `addon.json` déclare les intégrations du paquet : `browser` (fenêtre, chat, traductions, manettes), `catalogue`, `adminServer`, `adminScoreboard`, `access`, `readiness`, `preserveFiles`, `migration`, `deployment`, `controlTarget` et `networkPolicy`. Les ressources navigateur restent dans `client/` et `assets/` ; les données privées restent dans `data/`.

Les dépendances npm appartiennent au paquet et sont verrouillées par son `package-lock.json`. Le site les installe sans scripts npm. Les recettes natives `runtime.build` et `runtime.smoke` sont exécutées lors de la construction de l’image ; un moteur natif ajouté depuis le panel nécessite donc une reconstruction de l’image. La recette mGBA et ses vérifications SHA-256 appartiennent à Game Boy.

Pour tester avec le socle commun, installer le paquet dans le dépôt du site puis lancer `npm run test:addons`. Les modules `host-*` sont les adaptateurs vers les API publiques du site ; aucun import propre au jeu n’est nécessaire dans le cœur.
