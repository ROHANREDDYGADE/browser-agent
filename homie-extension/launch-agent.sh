#!/bin/bash

export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/1000

# Get screen dimensions dynamically
SCREEN=$(wlr-randr | grep "current" | grep -oP '\d+x\d+' | head -1)
SCREEN_W=$(echo $SCREEN | cut -dx -f1)
SCREEN_H=$(echo $SCREEN | cut -dx -f2)
WIN_W=$(( SCREEN_W * 60 / 100 ))
WIN_H=$(( SCREEN_H * 70 / 100 ))

# Enable developer mode
python3 -c "
import json, os
pref = '/tmp/chromium-profile/Default/Preferences'
os.makedirs(os.path.dirname(pref), exist_ok=True)
d = json.load(open(pref)) if os.path.exists(pref) else {}
d.setdefault('extensions', {}).setdefault('ui', {})['developer_mode'] = True
json.dump(d, open(pref, 'w'))
"

# Run the agent launcher
/usr/bin/python3 /home/baba/browser-agent/homie-extension/launch.py

# Delete profile so window-size is respected on fresh launch
rm -rf /tmp/chromium-profile

# Launch chromium
/usr/bin/chromium --new-window --force-device-scale-factor=1 \
  --load-extension=/home/baba/browser-agent/homie-extension \
  --window-size=${WIN_W},${WIN_H} \
  --window-position=0,0 \
  --user-data-dir=/tmp/chromium-profile \
  --no-first-run --no-default-browser-check --disable-session-restore \
  --ozone-platform=wayland