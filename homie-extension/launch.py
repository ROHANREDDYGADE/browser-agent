#!/usr/bin/env python3
import os
import json
import subprocess

# ── Paths ──────────────────────────────────────────────────────────
COOKIES_FILE   = os.path.expanduser("~/.local/share/agentbaba-webkit/cookies.txt")
EXTENSION_DIR  = os.path.expanduser("~/browser-agent/homie-extension")
TOKEN_FILE     = os.path.join(EXTENSION_DIR, "token.json")
ORANIS_EXEC    = "/usr/bin/oranis"

# ── Dynamic window sizing ──────────────────────────────────────────
def get_screen_size():
    """Get screen resolution via xrandr, fallback to 1920x1080."""
    try:
        out = subprocess.check_output(["xrandr"], text=True)
        for line in out.splitlines():
            if " connected" in line and "x" in line:
                # e.g. "eDP-1 connected 1920x1080+0+0"
                for part in line.split():
                    if "x" in part and "+" in part:
                        w, rest = part.split("x")
                        h = rest.split("+")[0]
                        return int(w), int(h)
    except Exception:
        pass
    return 1920, 1080  # safe fallback

def calc_window_geometry():
    """
    Full screen width.
    Height: 80% of screen (10% margin top, 10% margin bottom).
    Window centered horizontally; starts 10% from top.
    """
    sw, sh = get_screen_size()

    win_w  = sw                        # full width
    win_h  = int(sh * 0.80)            # 80% height
    pos_x  = 0                         # left edge
    pos_y  = int(sh * 0.10)            # 10% from top

    return win_w, win_h, pos_x, pos_y

# ── Token helpers ──────────────────────────────────────────────────
def extract_token():
    if not os.path.exists(COOKIES_FILE):
        raise RuntimeError(f"cookies.txt not found at {COOKIES_FILE}")

    with open(COOKIES_FILE) as f:
        for line in f:
            if "qwise_user_token" in line:
                parts = line.strip().split()
                if len(parts) >= 7:
                    return parts[6]
                elif "=" in line:
                    return line.strip().split("=", 1)[1]
    return None

def write_token(token):
    os.makedirs(EXTENSION_DIR, exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        json.dump({"token": token}, f)
    print("✅ Token injected into extension")

# ── Launch ─────────────────────────────────────────────────────────
def launch_browser():
    w, h, x, y = calc_window_geometry()
    print(f"🖥  Screen geometry → window {w}x{h} at ({x},{y})")
    print("🚀 Launching Oranis with Homie extension…")

    subprocess.run([
        ORANIS_EXEC,
        f"--load-extension={EXTENSION_DIR}",
        f"--window-size={w},{h}",
        f"--window-position={x},{y}",
        "--user-data-dir=/tmp/oranis-profile",
        "--no-first-run",
        "--no-default-browser-check",
    ])

# ── Main ───────────────────────────────────────────────────────────
def main():
    token = extract_token()
    if not token:
        raise RuntimeError("❌ Token not found in cookies.txt")
    print("🔑 Token found")
    write_token(token)
    launch_browser()

if __name__ == "__main__":
    main()