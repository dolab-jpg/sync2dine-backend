#!/usr/bin/env python3
import json, glob, os, re

print("=== SOHO66 env keys (masked) ===")
env_path = "/etc/tradepro-api.env"
if os.path.exists(env_path):
    for line in open(env_path):
        if re.match(r"^(SOHO66_|VAPI_SIP)", line):
            k, _, v = line.strip().partition("=")
            if any(x in k for x in ("PASS", "PASSWORD", "SECRET", "KEY")):
                print(f"{k}=***")
            else:
                print(f"{k}={v}")

print("=== synced-data phoneLines ===")
paths = glob.glob("/var/www/vhosts/b-diddies.com/**/synced-data.json", recursive=True)
print("found", len(paths), "files")
for p in paths[:8]:
    try:
        d = json.load(open(p))
        lines = d.get("phoneLines") or []
        print(p, "lines=", len(lines))
        for l in lines[:5]:
            print(
                " ",
                l.get("purpose"),
                l.get("label"),
                "user=",
                l.get("sipUsername"),
                "domain=",
                l.get("sipDomain"),
                "did=",
                l.get("did"),
                "hasPass=",
                bool(l.get("sipPassword")),
            )
    except Exception as e:
        print(p, e)
