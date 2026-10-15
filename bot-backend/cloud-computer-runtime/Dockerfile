# Build from the repository root so the desktop launcher stays shared with Bot Screen.
# docker build -f bot-backend/cloud-computer-runtime/Dockerfile -t bot-cloud-desktop:local .
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 HOME=/home/desktop \
    DISPLAY=:20 XAUTHORITY=/run/cloud-desktop/Xauthority \
    XDG_RUNTIME_DIR=/run/cloud-desktop

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash ca-certificates python3 chromium \
      tigervnc-standalone-server xfce4-panel xfwm4 xfdesktop4 xfce4-settings xfce4-terminal \
      dbus-x11 x11-xserver-utils x11-utils x11-xkb-utils xauth fonts-dejavu-core fonts-noto-cjk \
      xdotool xclip scrot procps \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/bash desktop \
    && mkdir -p /opt/cloud-desktop /run/cloud-desktop \
    && chown desktop:desktop /run/cloud-desktop \
    && chmod 0700 /home/desktop /run/cloud-desktop

COPY tools/bot_desktop/launcher.sh tools/bot_desktop/wallpaper.png /opt/cloud-desktop/
COPY bot-backend/cloud-computer-runtime/control.py /opt/cloud-desktop/control.py
COPY bot-backend/cloud-computer-runtime/entrypoint.sh /opt/cloud-desktop/entrypoint.sh
COPY bot-backend/cloud-computer-runtime/browser.sh /opt/cloud-desktop/browser.sh
RUN chmod 0755 /opt/cloud-desktop/*.sh && chmod 0644 /opt/cloud-desktop/control.py

USER 1000:1000
WORKDIR /home/desktop
ENTRYPOINT ["/opt/cloud-desktop/entrypoint.sh"]
