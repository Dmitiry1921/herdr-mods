#!/bin/sh
# Ставит моды в Herdr: свои — ссылками на этот клон (git pull обновляет сразу),
# правки встроенных модов (overrides/) — копией поверх, оригинал сохраняется как .orig.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
HERDR=${HERDR_APP_HOME:-${HERDR_HOME:-$HOME/.config/herdr-app}}
[ -d "$HERDR/mods" ] || { echo "Нет $HERDR/mods: Herdr не запускался или HERDR_APP_HOME другой"; exit 1; }
for m in "$HERE"/mods/*/; do
  n=$(basename "$m"); dst="$HERDR/mods/$n"
  [ -e "$dst" ] && [ ! -L "$dst" ] && mv "$dst" "$dst.bak.$(date +%s)"
  ln -sfn "$HERE/mods/$n" "$dst"; echo "мод $n"
done
for f in $(cd "$HERE/overrides" && find . -type f); do
  dst="$HERDR/mods/$f"
  [ -f "$dst" ] && [ ! -f "$dst.orig" ] && cp "$dst" "$dst.orig"
  cp "$HERE/overrides/$f" "$dst"; echo "правка $f"
done
mkdir -p "$HERDR/layouts" && cp "$HERE/layouts/"*.json "$HERDR/layouts/"
echo "Раскладка ygg: herdr-app do layout.switch '{\"name\":\"ygg\"}'"
