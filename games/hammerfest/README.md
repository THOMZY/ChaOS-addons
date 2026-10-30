# Hammerfest

Hammerfest integrates the [Eternalfest](https://eternalfest.net/) 2.5.2 build into a ChaOS website window. Runs, inventory, quests and history use ChaOS website accounts and the shared database.

## Install

From the ChaOS website repository:

```sh
node scripts/games/games-install.mjs hammerfest
node games/hammerfest/install.mjs <source-directory>
```

The source directory must contain the game and loader files:

```text
game.swf, patchman.swf, content.xml, loader.swf
locales.fr-FR.xml, locales.en-US.xml, locales.es-SP.xml
musics/music-01.mp3 through musics/music-06.mp3
```

The optional `ruffle/` directory is copied for same-origin Flash playback. Installed data lives in `games/hammerfest/data/` and is not versioned here. Restart the website after installation.

## Features

The add-on provides the game launcher, profile, item inventory, quests, leaderboard and result page. The server exposes the loader API under `/api/v1/` and account pages under `/api/v1/hammerfest/`.

The loader finds the API from its own origin, so serving it from the ChaOS website needs no extra URL configuration. Account routes use the website session. Start and result requests use the run UUID as a capability, following the Eternalfest protocol.

## Test

Run `npm test` from the ChaOS website repository. Tests require the game data above when exercising the real loader.

## Credits

Original game: [Hammerfest by Motion Twin](https://motion-twin.com/). Build, fixes and content: [Eternalfest](https://eternalfest.net/), AGPL components (loader and `hammerfest-db`). Flash player: [Ruffle](https://ruffle.rs/), MIT or Apache 2.0. Item icons come from the game itself, © Motion Twin. This is an unofficial version hosted on the ChaOS website.
