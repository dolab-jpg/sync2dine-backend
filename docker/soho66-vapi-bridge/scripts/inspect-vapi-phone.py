#!/usr/bin/env python3
import json, os, urllib.request

def load_env(path="/etc/tradepro-api.env"):
    env = {}
    for line in open(path):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
    return env

env = load_env()
key = env.get("VAPI_PRIVATE_KEY") or env.get("VAPI_API_KEY")
pid = env["VAPI_PHONE_NUMBER_ID"]
region = (env.get("VAPI_REGION") or "us").lower()
base = "https://api.eu.vapi.ai" if region == "eu" else "https://api.vapi.ai"
req = urllib.request.Request(
    f"{base}/phone-number/{pid}",
    headers={"Authorization": f"Bearer {key}"},
)
with urllib.request.urlopen(req) as r:
    d = json.load(r)

interesting = {}
for k, v in d.items():
    lk = k.lower()
    if any(x in lk for x in ("assist", "sip", "auth", "server", "status", "number", "credential", "name", "provider")):
        if not isinstance(v, (dict, list)):
            interesting[k] = v
print(json.dumps(interesting, indent=2))
print("all_keys", sorted(d.keys()))
