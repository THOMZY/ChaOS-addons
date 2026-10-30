#!/bin/sh
# Run from the persistent server directory, before downloads or Java startup.
# Empty configuration actively disables RCON, including on existing installs.
set -e

if [ -n "$MC_RCON_PASSWORD" ]; then
  case "$MC_RCON_PASSWORD" in
    *[!a-zA-Z0-9_-]*) echo '[setup] Invalid RCON password format' >&2; exit 1 ;;
  esac
  if [ "${#MC_RCON_PASSWORD}" -lt 32 ] || [ "${#MC_RCON_PASSWORD}" -gt 128 ]; then
    echo '[setup] RCON password must contain 32-128 random base64url/hex characters' >&2
    exit 1
  fi
  _port="${MC_RCON_PORT:-25575}"
  case "$_port" in
    *[!0-9]*|'') echo '[setup] Invalid RCON port' >&2; exit 1 ;;
  esac
  if [ "${#_port}" -gt 5 ] || [ "$_port" -lt 1 ] || [ "$_port" -gt 65535 ]; then
    echo '[setup] Invalid RCON port' >&2; exit 1
  fi
fi

set_prop() {
  _key="$1"; _value="$2"
  # Values above are restricted to property-safe characters.
  if grep -q "^${_key}=" server.properties 2>/dev/null; then
    sed -i "s|^${_key}=.*|${_key}=${_value}|" server.properties
  else
    # Ensure a pre-existing last line without a newline cannot swallow a key.
    printf '\n%s=%s\n' "$_key" "$_value" >> server.properties
  fi
}

if [ -n "$MC_RCON_PASSWORD" ]; then
  set_prop enable-rcon true
  set_prop rcon.port "${MC_RCON_PORT:-25575}"
  set_prop rcon.password "$MC_RCON_PASSWORD"
  set_prop broadcast-rcon-to-ops true
  echo "[setup] RCON enabled on port ${MC_RCON_PORT:-25575}"
else
  set_prop enable-rcon false
  set_prop rcon.password ''
  echo '[setup] RCON disabled'
fi
