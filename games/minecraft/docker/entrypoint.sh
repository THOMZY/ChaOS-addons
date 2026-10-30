#!/bin/sh
set -e

cd /server

# Existing installations were populated as root. Building a directory with the
# right owner does not fix a bind mount that hides it: Java then cannot open its
# logs/config/world files. Repair only root-owned entries, never follow symlinks
# or cross mounted filesystems, and drop privileges before any downloads/Java.
if [ "$(id -u)" = 0 ]; then
  echo '[setup] Preparing Minecraft volume ownership'
  find /server -xdev -user root -exec chown -h minecraft:minecraft {} +
  exec su-exec minecraft:minecraft /entrypoint.sh "$@"
fi

if [ ! -w /server ]; then
  echo '[setup] /server is not writable by the Minecraft user; check bind-mount ownership' >&2
  exit 1
fi

# EaglerXServer references this optional icon by default but logs an exception
# when it is missing. Supply our tiny 64x64 fallback only on installations that
# have no icon; never replace an operator's existing file (including symlinks).
if [ ! -e server-icon.png ] && [ ! -L server-icon.png ]; then
  cp /opt/minecraft/default-server-icon.png server-icon.png
fi

# Applied at every boot, before downloads, including explicit disablement of
# a previously enabled console. Never log credentials.
sh /configure-rcon.sh

# Download Paper 1.12.2 if not present
if [ ! -f paper.jar ]; then
  echo "[setup] Downloading Paper 1.12.2..."
  PAPER_BUILD=$(wget -qO- "https://api.papermc.io/v2/projects/paper/versions/1.12.2" \
    | grep -oE '"builds":\[[0-9,]+\]' \
    | grep -oE '[0-9]+' \
    | tail -1)
  wget -O paper.jar \
    "https://api.papermc.io/v2/projects/paper/versions/1.12.2/builds/${PAPER_BUILD}/downloads/paper-1.12.2-${PAPER_BUILD}.jar"
fi

# Download plugins if not present
mkdir -p plugins

if [ ! -f plugins/EaglerXServer.jar ]; then
  echo "[setup] Downloading EaglerXServer..."
  wget -O plugins/EaglerXServer.jar \
    "https://github.com/lax1dude/eaglerxserver/releases/download/v1.1.0/EaglerXServer.jar"
fi

if [ ! -f plugins/EaglerXRewind.jar ]; then
  echo "[setup] Downloading EaglerXRewind..."
  wget -O plugins/EaglerXRewind.jar \
    "https://github.com/lax1dude/eaglerxserver/releases/download/v1.1.0/EaglerXRewind.jar"
fi

exec java \
  -Xms512M -Xmx2G \
  -Dfile.encoding=UTF-8 \
  -Dcom.mojang.eula.agree=true \
  -jar paper.jar nogui
