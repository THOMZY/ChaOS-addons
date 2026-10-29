# Peggle

Peggle runs on shared tables in the ChaOS website. Every seated player receives the same level in their browser, and the highest score wins the pot.

## Install

From the ChaOS website repository:

```sh
node scripts/games-install.mjs peggle
```

Images, sounds and level definitions are included in this repository. Restart the website after installation.

## How it works

The server selects a level, validates scores and pays the winning score. The browser client renders the table and runs the Peggle physics. Level data is read from `media/levels.lua`; it is used by the server and is not published as a static file.

The ChaOS website owns the catalog entry, window and translations. The client is served under `/games/peggle/client/`, with artwork under `/peggle-images` and sounds under `/peggle-sounds`.

## Test

Run `npm test` from the ChaOS website repository. Tests cover table rules, levels, funded tables, the engine and the interface.

## Credits

Engine and artwork are adapted from the MIT-licensed World of Warcraft Classic Peggle add-on. The original source is preserved in the repository's local artwork references. [Peggle](https://en.wikipedia.org/wiki/Peggle) is a game by PopCap Games.
