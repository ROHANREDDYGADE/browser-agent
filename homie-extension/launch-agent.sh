#!/bin/bash

export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/1000

# Get screen dimensions dynamically
SCREEN=$(wlr-randr | grep "current" | grep -oP '\d+x\d+' | head -1)
SCREEN_W=$(echo $SCREEN | cut -dx -f1)
SCREEN_H=$(echo $SCREEN | cut -dx -f2)
WIN_W=$(echo "$SCREEN_W * 70 / 100" | bc)
WIN_H=$(echo "$SCREEN_H * 10 / 100" | bc)

echo "Screen: ${SCREEN_W}x${SCREEN_H} → Window: ${WIN_W}x${WIN_H}" >> /tmp/browser_launch.log

# Enable developer mode in Chromium profile
python3 -c "
import json, os
pref = os.path.expanduser('~/.config/chromium/Default/Preferences')
if os.path.exists(pref):
    d = json.load(open(pref))
    d.setdefault('extensions', {}).setdefault('ui', {})['developer_mode'] = True
    json.dump(d, open(pref, 'w'))
"

# Run the agent launcher
/usr/bin/python3 /home/baba/browser-agent/homie-extension/launch.py

# Launch Chromium
/usr/bin/chromium --new-window --force-device-scale-factor=1 \
  --load-extension=/home/baba/browser-agent/homie-extension \
  --window-size=${WIN_W},${WIN_H} \
  --window-position=0,0 \
  --no-first-run --no-default-browser-check --disable-session-restore \
  --ozone-platform=wayland