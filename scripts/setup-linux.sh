#!/usr/bin/env bash
# Окружение для проверок на Linux (облачная виртуалка / Ubuntu CI): системные
# зависимости Tauri 2 + npm ci. Приложение тут не запускается — ConPTY и окно
# есть только на Windows, — но cargo check/test и vitest работают.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v apt-get >/dev/null; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  # Retries/Timeout: на раннере apt иногда зависает на зеркале и держит джоб десятки минут.
  APT_OPTS="-o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30"
  # env внутри sudo: иначе sudo сбрасывает окружение, и debconf может ждать ввода.
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get $APT_OPTS update -qq
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get $APT_OPTS install -y -qq \
    build-essential pkg-config libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev
fi

npm ci
# tauri::generate_context! требует существующий frontendDist (../dist) даже для cargo check.
npm run build
