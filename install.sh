#!/bin/sh
# Ставит моды в Herdr: свои — копией в папку Herdr (после git pull запустить ещё раз; Herdr перечитывает мод только
# при записи в свою папку, правки в клоне по ссылке он не видел до перезапуска),
# правки встроенных модов (overrides/) — копией поверх, оригинал сохраняется как .orig.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
HERDR=${HERDR_APP_HOME:-${HERDR_HOME:-$HOME/.config/herdr-app}}
[ -d "$HERDR/mods" ] || { echo "Нет $HERDR/mods: Herdr не запускался или HERDR_APP_HOME другой"; exit 1; }
for m in "$HERE"/mods/*/; do
  n=$(basename "$m"); dst="$HERDR/mods/$n"
  [ -L "$dst" ] && rm "$dst"
  mkdir -p "$dst" && rsync -a --checksum --exclude jsconfig.json --exclude '*.d.ts' "$HERE/mods/$n/" "$dst/"; echo "мод $n"
done
for f in $(cd "$HERE/overrides" && find . -type f); do
  dst="$HERDR/mods/$f"
  [ -f "$dst" ] && [ ! -f "$dst.orig" ] && cp "$dst" "$dst.orig"
  # Только изменённое: каждая запись перезагружает мод, а с ним пропадает недописанный текст.
  cmp -s "$HERE/overrides/$f" "$dst" || { cp "$HERE/overrides/$f" "$dst"; echo "правка $f"; }
done
for d in themes layouts; do
  mkdir -p "$HERDR/$d"
  for f in "$HERE/$d/"*.json; do cmp -s "$f" "$HERDR/$d/$(basename "$f")" || cp "$f" "$HERDR/$d/"; done
done
# Откуда кнопка «Обновить» (ygg-status/update.sh) берёт новые версии: клон, из которого ставили руками.
mkdir -p "$HERDR/data/ygg-mods"
[ -d "$HERE/.git" ] && echo "$HERE" > "$HERDR/data/ygg-mods/repo"
echo "Раскладка ygg: herdr-app do layout.switch '{\"name\":\"ygg\"}'"
