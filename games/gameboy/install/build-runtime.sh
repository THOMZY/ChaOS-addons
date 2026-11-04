#!/bin/sh
set -eu

# The npm Linux binary requires glibc 2.38; rebuild its exact core on Bookworm.
MGBA_REVISION=012919433e331981d265f5a2fc3c550af57183b8
SHIM_REVISION=016c0cff3e40fa35a8e631f6897744bb08df89dd
PACKAGE_ROOT=$(pwd)
BUILD_ROOT=$(mktemp -d)
trap 'rm -rf "$BUILD_ROOT"' EXIT
cd "$BUILD_ROOT"
curl -fsSL "https://codeload.github.com/mgba-emu/mgba/tar.gz/$MGBA_REVISION" -o mgba.tar.gz
echo '5001fa588f0d55a9fb1126f4590d27d25740777dc3a09d343675d6e3d2320d8d  mgba.tar.gz' | sha256sum -c -
tar -xzf mgba.tar.gz
for source in mgba_shim.c mgba_shim.h; do
  curl -fsSL "https://raw.githubusercontent.com/ARISE-Foundation/node-mgba/$SHIM_REVISION/native/$source" -o "$source"
done
echo '56f1d86c77ec5e068aa12ad739c157b3972ae0818b1a7398ef0ca82ecb9b94bb  mgba_shim.c' | sha256sum -c -
echo 'a847e49fccc44be7b6a18a54efef9375a180e91ad70599e8047306afe9b67372  mgba_shim.h' | sha256sum -c -
cmake -S "mgba-$MGBA_REVISION" -B build \
  -DCMAKE_BUILD_TYPE=Release -DLIBMGBA_ONLY=OFF -DDISABLE_FRONTENDS=ON \
  -DBUILD_SHARED=ON -DBUILD_STATIC=OFF \
  -DBUILD_GL=OFF -DBUILD_GLES2=OFF -DBUILD_GLES3=OFF \
  -DENABLE_DEBUGGERS=ON -DENABLE_SCRIPTING=ON \
  -DENABLE_VFS=ON -DENABLE_DIRECTORIES=ON \
  -DUSE_ZLIB=ON -DUSE_PNG=ON \
  -DUSE_DISCORD_RPC=OFF -DUSE_EPOXY=OFF -DUSE_FFMPEG=OFF \
  -DUSE_FREETYPE=OFF -DUSE_JSON_C=OFF -DUSE_LIBZIP=OFF \
  -DUSE_LUA=OFF -DUSE_SQLITE3=OFF -DUSE_EDITLINE=OFF
cmake --build build --parallel 2
cd "$PACKAGE_ROOT"
mkdir -p ./node_modules/node-mgba/native ./node_modules/node-mgba/vendor/mgba-dist/lib ./node_modules/node-mgba/licenses
cp -L "$BUILD_ROOT"/build/libmgba.so.0.11 ./node_modules/node-mgba/vendor/mgba-dist/lib/libmgba.so.0.11
cc -O3 -fPIC -shared -DENABLE_VFS=1 -DENABLE_DIRECTORIES=1 \
  -I"$BUILD_ROOT/mgba-$MGBA_REVISION/include" -I"$BUILD_ROOT/build/include" \
  -o ./node_modules/node-mgba/native/libmgba_shim.so "$BUILD_ROOT"/mgba_shim.c \
  -L"$BUILD_ROOT/build" -lmgba -Wl,-rpath,'$ORIGIN/../vendor/mgba-dist/lib'
cp "$BUILD_ROOT/mgba-$MGBA_REVISION/LICENSE" ./node_modules/node-mgba/licenses/mgba-MPL-2.0.txt
