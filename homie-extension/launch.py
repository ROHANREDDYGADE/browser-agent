#!/usr/bin/env python3
import os
import json

COOKIES_FILE  = os.path.expanduser("~/.local/share/agentbaba-webkit/cookies.txt")
EXTENSION_DIR = os.path.expanduser("~/browser-agent/homie-extension")
TOKEN_FILE    = os.path.join(EXTENSION_DIR, "token.json")

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
    print("✅ Token injected")

def main():
    token = extract_token()
    if not token:
        raise RuntimeError("❌ Token not found in cookies.txt")
    print("🔑 Token found")
    write_token(token)

if __name__ == "__main__":
    main()