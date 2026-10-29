# Game Boy / Color / Advance

Game Boy is a shared server-side console for the ChaOS website. One native [mGBA](https://mgba.io/) instance produces video and audio for connected browsers. Signed-in players share controls; visitors can watch. ROM files are never sent to browsers.

## Install

From the ChaOS website repository:

```sh
npm ci --ignore-scripts
node scripts/games-install.mjs --from ../ChaOS-games gameboy
node games/gameboy/install.mjs [source-directory]
```

The source directory is optional. Open the Game Boy library to upload `.gb`, `.gbc` or `.gba` cartridges. Restart the website after installation.

The package supports Windows x64 and Linux x64. It uses `node-mgba` and `@evan/opus`, supplied by the ChaOS website. Other architectures need a native compatibility check.

## Library, saves and clock

Cartridges, `.sav` files, artwork and the index are stored in `games/gameboy/data/`, which must be mounted read/write. Saves belong to the shared game, not to an individual account.

The library can remove a cartridge through its confirmation button or `DELETE /gameboy-api/roms/<filename>`. The cartridge, save, clock file, artwork and index entry are removed when no other cartridge uses them.

MBC3 timer cartridges keep their clock in a separate `<rom>.rtc.json` file. The clock is restored when the cartridge starts and saved every 30 seconds, on cartridge changes and during clean shutdown.

Artwork is looked up by CRC32 through the public RetroBase Collection API. If artwork is unavailable, the library draws a simple title box. ROMs and saves remain private.

## Controls and streaming

The interface provides Game Boy and Game Boy Advance shells in HTML/CSS. Arrow keys control the D-pad; `X`/`W` is A; `Z` is B; Enter is Start; Shift is Select. `Q` and `E` control L/R on Advance cartridges.

The `/gameboy-ws` transport checks origin, account bans and revocation. Protocol v4 sends indexed video frames and 48 kHz mono Opus, or PCM when WebCodecs is unavailable. Minimizing pauses the local stream; closing saves the cartridge and disconnects viewers.

## Test

Run the browser shell check from this repository:

```sh
node gameboy/tests/shell.browser.mjs
```

After installation, run the Game Boy tests from the ChaOS website repository:

```sh
node --import ./tests/helpers/isolated-env.mjs --test games/gameboy/tests/*.test.js games/gameboy/tests/*.test.mjs
npm run test:gameboy:browser
```

## Credits

Emulation: [mGBA](https://mgba.io/). Audio encoding uses [Opus](https://opus-codec.org/). Artwork lookup uses the public RetroBase Collection service. The ChaOS website integration is maintained in this repository.
