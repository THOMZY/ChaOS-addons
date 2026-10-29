# Minecraft

Minecraft adds an [EaglerCraft](https://github.com/lax1dude/eaglercraft) browser client at `/mc/`, a WebSocket proxy at `/mc-ws`, and a Paper server with [EaglerXServer](https://github.com/lax1dude/eaglercraftxserver).

## Install

From the ChaOS website repository:

```sh
node scripts/games-install.mjs minecraft
docker compose --profile minecraft up -d minecraft
```

The container creates Paper and its plugins on first start. Existing worlds and configuration are kept in `games/minecraft/data/`. No world is included in this repository. Mount this directory read/write and stop the container before manual migrations.

## Configuration

`MC_HOST` and `MC_PORT` configure the server tunnel. `MC_RCON_PASSWORD` protects the private RCON console. Include `minecraft` in `COMPOSE_PROFILES` for local Compose commands. The reverse proxy must forward WebSocket upgrades for `/mc-ws`.

## Test

Run `npm test` and `node scripts/check-mc-csp-browser.mjs` from the ChaOS website repository.

## Credits

Client: [EaglerCraft](https://github.com/lax1dude/eaglercraft). Server: [Paper](https://papermc.io/) and [EaglerXServer](https://github.com/lax1dude/eaglercraftxserver).
