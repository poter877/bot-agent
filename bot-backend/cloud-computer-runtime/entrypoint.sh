#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /run/cloud-desktop /tmp/.X11-unix "$HOME/.config" "$HOME/.cache" "$HOME/.local/share" # no-tmp: ok — X11 fixes this socket directory inside the isolated container.
export HERMES_BD_PROFILE=cloud-computer HERMES_BD_DISPLAY_NUM=20
export HERMES_BD_SOCKET=/run/cloud-desktop/rfb.sock HERMES_BD_XAUTH="$XAUTHORITY"
export HERMES_BD_ENV_FILE=/run/cloud-desktop/env HERMES_BD_CONFIG_HOME="$HOME/.config"
export HERMES_BD_CACHE_HOME="$HOME/.cache" HERMES_BD_DATA_HOME="$HOME/.local/share"
export HERMES_BD_GEOMETRY="${CLOUD_DESKTOP_WIDTH:-1440}x${CLOUD_DESKTOP_HEIGHT:-900}"
export HERMES_BD_BROWSER_EXEC=/opt/cloud-desktop/browser.sh
export HERMES_BD_BROWSER_EXEC_LINE=/opt/cloud-desktop/browser.sh
exec /opt/cloud-desktop/launcher.sh
