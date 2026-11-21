#!/bin/sh
# Обновление модов с GitHub по кнопке «Обновить» в нижней строке (ygg-status), а не в момент пуша: живой Herdr
# перечитывает мод при записи, и набранный или надиктованный текст пропадал (пользователь, 21.11.2026).
#   update.sh check  → {"behind":N,"latest":"<sha>","log":["тема коммита",...]}
#   update.sh apply  → ставит origin/main из архива git (рабочий клон не трогает), запоминает версию
set -e
HERDR=${HERDR_APP_HOME:-$HOME/.config/herdr-app}
STATE="$HERDR/data/ygg-mods"
REPO=$(cat "$STATE/repo" 2>/dev/null || true)
[ -d "$REPO/.git" ] || { echo '{"behind":0,"error":"нет клона herdr-mods"}'; exit 0; }
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
git -C "$REPO" fetch -q origin main 2>/dev/null || true
latest=$(git -C "$REPO" rev-parse origin/main)
have=$(cat "$STATE/installed" 2>/dev/null || true)
case "$1" in
  check)
    if [ "$have" = "$latest" ]; then echo "{\"behind\":0,\"latest\":\"$latest\"}"; exit 0; fi
    range="origin/main"; [ -n "$have" ] && git -C "$REPO" cat-file -e "$have" 2>/dev/null && range="$have..origin/main"
    n=$(git -C "$REPO" rev-list --count $range)
    log=$(git -C "$REPO" log --format=%s -n 8 $range | cut -c1-140 | sed 's/\\/\\\\/g; s/"/\\"/g; s/.*/"&"/' | paste -sd, - | sed 's/^/[/; s/$/]/')
    echo "{\"behind\":$n,\"latest\":\"$latest\",\"log\":$log}"
    ;;
  apply)
    tmp=$(mktemp -d)
    git -C "$REPO" archive origin/main | tar -x -C "$tmp"
    sh "$tmp/install.sh" >/dev/null
    rm -rf "$tmp"
    echo "$latest" > "$STATE/installed"
    echo "{\"behind\":0,\"latest\":\"$latest\"}"
    ;;
esac
