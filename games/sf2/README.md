# Street Fighter II

Street Fighter II is an independent fighting add-on for the ChaOS website. It bundles a vanilla JavaScript client and media in `web/`, served under `/sf2/`. It does not require MUGEN or a Docker service.

## Install

From the ChaOS website repository:

```sh
node scripts/games/games-install.mjs sf2
```

Restart the website after installation. The shared platform supplies the window, translations, session and wager rules.

## Test

Run `npm test` from the ChaOS website repository. Tests cover the runtime, funding, refunds, socket shutdown and public HTTP routes.

## Credits

Original project and playable demo: [Street Fighter 2 JavaScript by Iuri Torres](https://iuritorres.github.io/street-fighter-2-javascript/). Development was guided by [Shezzor's Dev Corner](https://www.youtube.com/@ShezzorsDevCorner). The ChaOS integration is maintained in this repository.
