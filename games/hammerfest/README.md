# Hammerfest

Hammerfest integrates the [Eternalfest](https://eternalfest.net/) 2.5.2 build into a ChaOS website window. Runs, inventory, quests and history use ChaOS website accounts and the shared database.

## Install

From the ChaOS website repository:

```sh
node scripts/games/games-install.mjs hammerfest
```

That is the whole installation: the game build (engine, content, locales, musics — 9.7 MB) ships with the add-on in `game/`, so the regular add-on install and deployment copy it. Nothing is downloaded from Eternalfest and no file has to be copied by hand.

The Flash reader is **not** shipped here: it comes from npm (`@ruffle-rs/ruffle`, a ChaOS website dependency) and this add-on serves it from `node_modules` at `/hammerfest/data/ruffle/`.

`game/` must contain:

```text
game.swf, patchman.swf, content.xml, loader.swf
locales.fr-FR.xml, locales.en-US.xml, locales.es-SP.xml
musics/music-01.mp3 through musics/music-06.mp3
```

`dev/patchman.swf` is the optional debug build (same engine and content, patcher forcing the game's debug controls). It is served only to administrator accounts, and only when the page is opened with `?dev=1`.

## Language

Both the game and the pages follow the account language on the site (`chat_user_settings.language`, switched in the profile settings):

- the server resolves the locale (`fr-FR` or `en-US`, validated against the build's `main_locale` + `i18n` keys) and the loader gets it as the run's `locale`;
- `client/i18n.js` holds the page strings (launch, ranking, fridge/items/quests, result) and the English names of modes and options, applied on the `locale` returned by `/api/v1/hammerfest/config`;
- `server/locale-names.js` translates the *data*: item names come from `game/locales.<locale>.xml`, while `catalog/labels.en.json` carries the English families (52) and quests (76, name + description). Anything missing falls back to the French catalogue, so a new entity never breaks a page; `tests/locale-labels.test.js` fails when the file stops covering the catalogue.

Anonymous visitors get `fr-FR`. The build also ships an `es-SP` patch, unused until the site offers Spanish.

Restart the website after installing.

## Features

The add-on provides the game launcher, profile, item inventory, quests, leaderboard and result page. The server exposes the loader API under `/api/v1/` and account pages under `/api/v1/hammerfest/`.

The loader finds the API from its own origin, so serving it from the ChaOS website needs no extra URL configuration. Account routes use the website session. Start and result requests use the run UUID as a capability, following the Eternalfest protocol.

## Test

Run `npm test` from the ChaOS website repository. Tests that exercise the real loader use the build shipped in `game/`.

## Credits

Original game: [Hammerfest by Motion Twin](https://motion-twin.com/). Build, fixes and content: [Eternalfest](https://eternalfest.net/), AGPL components (loader and `hammerfest-db`). Flash player: [Ruffle](https://ruffle.rs/), MIT or Apache 2.0. Item icons come from the game itself, © Motion Twin. This is an unofficial version hosted on the ChaOS website.
