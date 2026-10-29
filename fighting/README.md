# Fighting / MUGEN

Fighting integrates the [M.U.G.E.N engine](https://www.elecbyte.com/mugen/) with the ChaOS website. It keeps the existing runtime and sandbox while the website provides the window, accounts and shared session rules.

## Install

From the ChaOS website repository:

```sh
node scripts/games-install.mjs fighting
```

Copy `Characters/` and `Stages/` into `games/fighting/data/`, then restart the website. These large game assets are intentionally not included in Git. The old `server/games/MUGEN` directory is migrated once when the add-on is installed.

The public routes are `/mugen`, `/mugen-stages` and `/api/mugen`. Street Fighter II is a separate add-on.

## Test

Run `npm test` from the ChaOS website repository. Tests cover the runtime, funding and refunds, socket shutdown, HTTP routes, cache headers and data migration.

## Credits

Engine: [M.U.G.E.N](https://www.elecbyte.com/mugen/). Characters and stages are supplied separately by their respective authors and are not redistributed here.
