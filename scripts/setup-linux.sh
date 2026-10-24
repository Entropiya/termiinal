#!/usr/bin/env bash
# Окружение для проверок на Linux (облачная виртуалка / Ubuntu CI): системные
# зависимости Tauri 2 + npm ci. Приложение тут не запускается — ConPTY и окно
# есть только на Windows, — но cargo check/test и vitest работают.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v apt-get >/dev/null; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO apt-get update -qq
  DEBIAN_FRONTEND=noninteractive $SUDO apt-get install -y -qq \
    build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev
fi

npm ci
# tauri::generate_context! требует существующий frontendDist (../dist) даже для cargo check.
npm run build
