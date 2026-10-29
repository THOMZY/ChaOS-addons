# Worms

Worms provides multiplayer rooms, wagers and tickets for the ChaOS website. The server handles rooms, rules and timers; the browser handles the battlefield, controls, graphics and sound.

## Install

From the ChaOS website repository:

```sh
node scripts/games-install.mjs worms
```

The images and sounds are included in this repository, so no separate data download is required. Restart the website after installation.

## How it works

Players join a room, choose a map and take turns. The server validates turns, weapons, scores and wagers. A spectator can watch without gaining control. The browser client loads its modules when the Worms window opens.

The client is split into small modules for media, terrain, sprites, effects, physics, controls, menus, HUD and network events. Each module releases its own listeners, timers, canvases and audio when a round ends or the window closes. Shared match state remains owned by the controller.

## Test

Run `npm test` from the ChaOS website repository. Tests cover rooms, rules, wagers, socket shutdown, wallet integration and browser controls.

## Credits

The browser game and media are adapted from [CiaranMcCann's HTML5 Worms Armageddon clone](https://github.com/CiaranMcCann/worms) under the Apache-2.0 license. The original Worms game is a work of [Team17](https://www.team17.com/). The ChaOS website integration and server rules are maintained in this repository.
