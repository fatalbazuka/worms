#!/bin/sh
# Пишет env.js из переменных окружения при каждом старте контейнера.
# Пустая переменная — значение по умолчанию из кода игры.
set -eu

OUT="${WORMS_ENV_FILE:-/usr/share/nginx/html/env.js}"

# Строка для JS: экранируем обратную косую и кавычку
js() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/\\\\'/g"; }

{
  echo "// Сгенерировано при старте контейнера ($(date -u +%Y-%m-%dT%H:%M:%SZ))."
  echo "window.WORMS_NET = Object.assign({"
  [ -n "${SUPABASE_URL:-}" ] && echo "  url: '$(js "$SUPABASE_URL")',"
  [ -n "${SUPABASE_ANON_KEY:-}" ] && echo "  anonKey: '$(js "$SUPABASE_ANON_KEY")',"
  [ -n "${SUPABASE_LEGACY_KEY:-}" ] && echo "  legacyKey: '$(js "$SUPABASE_LEGACY_KEY")',"
  echo "}, window.WORMS_NET || {});"
  echo "window.WORMS_TG = Object.assign({"
  [ -n "${TELEGRAM_BOT:-}" ] && echo "  bot: '$(js "$TELEGRAM_BOT")',"
  [ -n "${TELEGRAM_APP:-}" ] && echo "  app: '$(js "$TELEGRAM_APP")',"
  echo "}, window.WORMS_TG || {});"
  case "${WORMS_UI:-}" in
    desktop|touch) echo "window.WORMS_UI = window.WORMS_UI || '$WORMS_UI';" ;;
  esac
} > "$OUT"

echo "worms: env.js записан в $OUT"
