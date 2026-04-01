#!/bin/bash

# Force correct dbus and wayland env
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/1000

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
  --window-size=1200,600 --window-position=0,0 \
  --no-first-run --no-default-browser-check --disable-session-restore