# MUGEN

MUGEN runs M.U.G.E.N characters and stages in the ChaOS website with [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO), the open-source engine that aims for compatibility with MUGEN 1.1 and handles WinMUGEN and MUGEN 1.0 content. The engine is the browser build of Ikemen GO ([energyjp/ikemen-go-web](https://github.com/energyjp/ikemen-go-web)), compiled to WebAssembly and rendered with WebGL 2.

The website provides the window, accounts, wallet and chat socket. This add-on provides:

- the lobby: paid 1v1 duels, spectators and training against the CPU;
- the engine frame (`client/engine/`): Ikemen GO with a browser file system over the add-on routes and a netplay bridge over the chat socket;
- the server: rooms, stakes, relay of the engines' netplay traffic and settlement of the result both engines report.

## Install

From the ChaOS website repository:

```sh
node scripts/games/games-install.mjs mugen
node games/mugen/install.mjs
```

The compiled engine ships in `engine/mugen-engine.tar.gz` (about 25 MiB).
`install.mjs` checks its SHA-256 and pinned version, then installs it into
`games/mugen/data/engine/` without network access, Git or Go. Characters and stages
are preserved. The archive includes the WASM binary, matching Go loader, engine
scripts, screenpack, fonts and upstream licence notices; it contains no user packs.

With `--build` the installer clones and compiles the pinned commits (needs Git
and Go); with `--bundle <dir>` it installs an existing compiled bundle. Without
the shipped archive and without either option, it stops with an error: nothing
is downloaded.

The library button in the lobby, character picker and training view opens the
library inside the MUGEN window, not in a second window: the view underneath
stays mounted, so a player who only browses keeps the fighter they had already
picked, and an import re-renders that view with the new pack.
`client/library-view.js` holds the shelf shared with `/mugen-library`, which
still serves it as a standalone page for a direct link. Signed-in users can upload
character or stage ZIP packs; visitors can browse. The archive must include a
fighter/stage `.def`, its SFF sprite file and the resources its definition uses.
RAR and 7z files must first be converted to ZIP. The website installs `yauzl`
as a production dependency to read ZIP archives.

Imports are limited to 128 MiB compressed, 256 MiB unpacked, 128 MiB per file and
5,000 archive entries, with two simultaneous uploads. Files are checked and staged
before an atomic publish. Existing packs are never overwritten; a ZIP with an
already installed name is refused. Traversal, links, conflicting paths and web
executables are refused. A successful import refreshes the open character picker.
The data directory must be writable by the website process, including in Docker.

Packs can also be copied manually, one folder each:

- characters in `games/mugen/data/Characters/<folder>/` (the `.def` can sit one folder deeper);
- stages in `games/mugen/data/Stages/<folder>/` or directly in `Stages/`.

Files are found without regard to case, as on Windows. These assets are not stored in Git. The old `server/games/MUGEN` directory and the former `games/fighting/` add-on are migrated by the website installer.

The title-bar music and SFX sliders update the running engine independently,
including during training and spectating. These local settings are remembered
in the browser and never change another player's audio.

The MUGEN window precompiles the engine in the lobby and keeps that compiled
module and recently used pack bytes in RAM between matches. The RAM limit is
256 MiB by default, 512 MiB when the browser reports at least 8 GiB of device
memory, and 128 MiB on devices reporting less than 4 GiB. This is an upper bound,
not a reservation; it is separate from upload limits and the temporary disk cache.
A temporary Cache Storage cache retains the files of previously loaded fighters
and stages even after RAM eviction, including packs larger than 128 MiB. It is
private to this MUGEN instance and deleted on disposal; page exit also requests
cleanup. If browser storage is unavailable or full, the bounded RAM cache remains.
Each MUGEN window keeps one native Go engine, its iframe, decoded fighters and
WebGL textures alive across training, versus and spectator matches. Returning
to the lobby parks that iframe without moving it in the DOM. Compiled fighter
assets are retained by player slot and definition, including after selecting
another fighter. Match state, statistics, netplay, replay recording and playback
are reset for each launch; asynchronous packets stay attached to their own match.
The first fight frame finishes its GPU work and waits for a browser paint before
simulation continues, so a match cannot run behind its initial loading screen.
The browser build streams stage music instead of predecoding an entire track
into RAM on a Go goroutine: WASM has no second thread for that desktop task,
which would otherwise block the first visible frames for tens of seconds.
Closing MUGEN unloads the engine and deletes its temporary file cache. Minimizing
it keeps the session alive. Importing a new pack extends the virtual filesystem
on the next match without throwing away previously loaded fighters.
All core file URLs carry the bundle revision so new readiness patches cannot
accidentally run alongside stale Lua scripts cached by an older bundle.

Stage thumbnails are small server-generated stills of their SFF background
layers, shared by the picker and library. Animated layers use their first frame;
parallax and controllers remain exclusive to the running game.

The file manifest repairs stage music paths that still refer to an old `sound/`
directory. Only music actually present in the same installed pack is used;
ambiguous or missing tracks and stages with no declared music stay unchanged.
Edits affect the virtual definition only and preserve the original legacy bytes.

## How a duel works

1. The creator opens a room with a bet; the opponent joins and pays the same bet.
2. Each player picks a fighter; the creator also picks the stage (random by default).
3. The server sends both players the match: fighters, stage and roles. The creator hosts and plays side 1.
4. Each browser starts Ikemen GO with its quick-match options. The engines talk through the chat socket (`mugen:net` in, `mugen:input` out): no peer-to-peer connection or TURN server is needed. Rollback netcode is on.
5. When the match ends, each engine reports the winning side. Two matching reports pay the winner; reports that disagree, or an engine that stopped, refund both players. A single report wins after 30 seconds. Leaving the match, or the site, forfeits it.

Spectators run the same engine and packs locally. The host sends the native
Ikemen replay header (settings and content fingerprint), synchronization seeds,
and the two players' confirmed inputs, including analog axes. GGPO's confirmed
queues supply these inputs before they are discarded; predicted rollback frames
are never published. No video is captured or encoded.

The server retains the ordered history throughout the match. A late spectator
replays from the initial seed at accelerated speed until close to live play,
then continues at normal speed with a small network delay. The growing replay
reader waits for missing data instead of treating it as the end of the replay.
Spectators cannot send gameplay input or settle the match. Final results wait
for their local replay to finish. Closing the viewer stops its engine.

## Engine bundle

`engine/engine.json` pins one commit of the browser fork, one commit of the [default screenpack](https://github.com/ikemen-engine/Ikemen_GO-Elecbyte-Screenpack) and one Go version. The engine is compiled by hand and shipped inside the add-on:

```sh
node games/mugen/engine/build.mjs --ikemen <ikemen-go-web checkout> --screenpack <screenpack checkout> --out <dir>
node games/mugen/engine/bundle.mjs <dir>
```

`bundle.mjs` writes `engine/mugen-engine.tar.gz` and its checksum file
`engine/mugen-engine.bundle.json`; commit both with the add-on.

`engine/patches.mjs` lists the Lua changes; `engine/source-patches.mjs` and
`engine/chaos_replay*.go` adapt native replay recording and pacing for the browser.
`engine/chaos_audio_js.go` applies live music and SFX settings on the engine thread.
Source patches are applied to a private build copy. The build stops if the pinned
sources no longer match. `engine.json` includes a bundle revision so source patch
changes produce a new release. Input spectators require a rebuilt bundle with
`replayProtocol: 1`; live audio needs `audioProtocol: 1`. The readiness marker
needs `startupProtocol: 1`. Resident sessions and first-frame presentation need
`sessionProtocol: 2` (bundle revision 5) for repeated versus and replay sessions.
The client explicitly refuses older bundles until the engine is updated.

## Routes and events

Routes: `/mugen/*` (characters), `/mugen-stages/*` (stages), `/games/mugen/engine/*` (engine), `/games/mugen/client/*`, `/api/mugen/chars`, `/api/mugen/stages`, `/api/mugen/fs` (the engine's file list, `503` until the engine is installed).

Library: `GET /mugen-library` (the same shelf as a standalone page; the MUGEN
window mounts it in place), `GET /api/mugen/packs`, and
`POST /api/mugen/packs/{characters|stages}?name=<archive.zip>`. Uploads require a
current account, the same origin and `Content-Type: application/octet-stream`.
The upload service stops admission and drains staging work on shutdown.

Images: `/api/mugen/portrait?path=<character.def>` and
`/api/mugen/stage-preview?path=<stage.def>` only serve catalogued packs.

Events sent by the client: `mugen:rooms_request`, `mugen:create`, `mugen:join`, `mugen:select_char`, `mugen:net`, `mugen:result`, `mugen:forfeit`, `mugen:spectate`, `mugen:unspectate`, `mugen:replay`.

The website's MUGEN entry must forward `mugen:replay` and `mugen:spectate_start`.
Replay chunks carry `{roomId, offset, data}` and are accepted only from the host,
in byte order, up to 32 KiB per chunk, 128 KiB per second and 16 MiB per match.
A gap or exceeded limit invalidates the history; viewers are notified and a
damaged replay is never served to late arrivals. History is cleared when the
match ends. Leaving or closing the viewer unsubscribes it.

## Test

Run `npm test` from the ChaOS website repository. Tests cover rooms, stakes and settlement, the netplay relay, real sockets, routes and the file list, the browser file system, the netplay bridge and the build patches.

To test real netplay and a late spectator with the compiled WebAssembly engine,
using only the screenpack's Kung Fu Man assets:

```sh
node games/mugen/tests/browser-replay.mjs <built-bundle-directory> <screenpack-checkout>
```

This starts an isolated local HTTP server and headless Chromium. Set `BROWSER_PATH`
if Chromium is not in a standard location. The test compares the replay's complete
match statistics to the host's, verifies catch-up, and uses no site accounts or bets.
It repeats the versus and spectator sessions in the same three native engines,
swaps host/guest roles, checks a fresh result and replay offset, then switches to
offline play and back to an already loaded fighter without decoding it again.

It also changes BGM/SFX volumes during play and checks that the Go mixer applies
them without affecting the other player, then starts another match using the
same window cache and verifies a single engine download. To verify real library uploads, the
in-window panel refreshing the open picker, mobile layout and signed-out access
from the website checkout:

```sh
node games/mugen/tests/browser-library.mjs
```

This uses an isolated test account, database and pack directory.

To check successive native matches with installed packs from the website checkout:

```sh
node games/mugen/tests/browser-matches.mjs [character-path] [stage-path]
```

The test launches two training matches through the actual UI, checks that the
same iframe and Go filesystem survive, that both native fighters are reused
without decoding, and that loading disappears only after a rendered frame.
It deliberately delays browser paint acknowledgment and verifies the native
engine does not advance during that delay, then disposes the
MUGEN scope and checks that its temporary browser cache is removed. It also serves
an obsolete unversioned Lua script to detect mixed engine versions.
With the music-bearing default stage it also checks non-silent audio output with
SFX muted, after keyboard input unlocks the browser engine's audio context.

## Credits

Engine: [Ikemen GO](https://github.com/ikemen-engine/Ikemen-GO) (MIT) and its browser build [ikemen-go-web](https://github.com/energyjp/ikemen-go-web) by energyjp (MIT). Default screenpack, lifebars and fonts: [Ikemen GO screenpack](https://github.com/ikemen-engine/Ikemen_GO-Elecbyte-Screenpack), CC BY 3.0, with Elecbyte's MUGEN fonts under CC BY-NC 3.0. M.U.G.E.N by [Elecbyte](https://www.elecbyte.com/mugen/). Characters and stages belong to their authors and are not redistributed here.
