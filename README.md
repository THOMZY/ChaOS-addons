# ChaOS-games

Game add-ons for the ChaOS website. Each add-on contains the code, browser client, optional media and tests for one game. The website keeps the catalog, windows, translations and shared accounts.

## Games

| Add-on | What it provides |
| --- | --- |
| [Surf](surf/README.md) | Multiplayer surf rooms, times and rankings |
| [Quake 3](quake/README.md) | WebAssembly client and native server tunnel |
| [Minecraft](minecraft/README.md) | EaglerCraft client and Minecraft server container |
| [Worms](worms/README.md) | Multiplayer Worms rooms and browser game |
| [Peggle](peggle/README.md) | Shared Peggle tables and scoring |
| [Fighting / MUGEN](fighting/README.md) | MUGEN runtime and sandbox |
| [Street Fighter II](sf2/README.md) | Standalone browser fighting game |
| [Hammerfest](hammerfest/README.md) | Eternalfest client, inventory and quests |
| [Game Boy](gameboy/README.md) | Shared mGBA console and cartridge library |

## Install an add-on

From the ChaOS website repository, with this repository checked out beside it as `../ChaOS-games`:

```sh
node scripts/games-install.mjs surf
```

Some games need a separate data install. Follow that game's README, then restart the ChaOS website. Use `--from <directory>` when this repository is elsewhere. Installed data stays in `games/<id>/data/` and is not stored in this repository.

## Add-on structure

```text
<id>/
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

ChaOS-games is an integration project. Individual game credits and source links are listed in each add-on README. The ChaOS website is the host platform.
