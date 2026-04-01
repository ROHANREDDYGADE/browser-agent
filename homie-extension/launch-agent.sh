#!/bin/bash
echo "$(date): Script triggered, caller: $(ps -p $PPID -o comm=)" >> /tmp/homie-launch.log
export DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus
export WAYLAND_DISPLAY=wayland-1
export XDG_RUNTIME_DIR=/run/user/1000

# Lockfile guard
LOCKFILE=/tmp/homie-chromium.lock
if [ -f "$LOCKFILE" ] && kill -0 $(cat "$LOCKFILE") 2>/dev/null; then
    echo "Already running (PID $(cat $LOCKFILE)), exiting."
    exit 0
fi

SCREEN=$(wlr-randr | grep "current" | grep -oP '\d+x\d+' | head -1)
SCREEN_W=$(echo $SCREEN | cut -dx -f1)
SCREEN_H=$(echo $SCREEN | cut -dx -f2)
WIN_W=$(( SCREEN_W * 60 / 100 ))
WIN_H=$(( SCREEN_H * 70 / 100 ))

python3 -c "
import json, os
pref = '/tmp/chromium-profile/Default/Preferences'
os.makedirs(os.path.dirname(pref), exist_ok=True)
d = json.load(open(pref)) if os.path.exists(pref) else {}
d.setdefault('extensions', {}).setdefault('ui', {})['developer_mode'] = True
json.dump(d, open(pref, 'w'))
"

/usr/bin/python3 /home/baba/browser-agent/homie-extension/launch.py

rm -rf /tmp/chromium-profile

/usr/bin/chromium --new-window --force-device-scale-factor=1 \
  --load-extension=/home/baba/browser-agent/homie-extension \
  --window-size=${WIN_W},${WIN_H} \
  --window-position=0,0 \
  --user-data-dir=/tmp/chromium-profile \
  --no-first-run --no-default-browser-check --disable-session-restore \
  --ozone-platform=wayland &

# Save PID and clean up lock when done
echo $! > "$LOCKFILE"
wait $!
rm -f "$LOCKFILE"