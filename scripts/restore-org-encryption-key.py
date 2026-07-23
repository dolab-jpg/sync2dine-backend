#!/usr/bin/env python3
"""Restore ORG_ENCRYPTION_KEY from pre-rotation JWT_SECRET in .env.bak-bom.

crypto.ts falls back to JWT_SECRET when ORG_ENCRYPTION_KEY is unset, so rotating
JWT_SECRET without a dedicated encryption key breaks org secret decryption.
"""
from pathlib import Path
import sys

ROOT = Path("/var/www/vhosts/sync2dine.io/sync2dine-backend")
BAK = ROOT / ".env.bak-bom"
ENV = ROOT / ".env"


def main() -> int:
    if not BAK.exists():
        print("bak_missing", file=sys.stderr)
        return 1
    text = BAK.read_bytes().decode("utf-8-sig", errors="replace")
    old_jwt = None
    for line in text.splitlines():
        if line.startswith("JWT_SECRET="):
            old_jwt = line.split("=", 1)[1].strip().strip('"').strip("'")
            break
    if not old_jwt:
        print("old_jwt_missing", file=sys.stderr)
        return 1
    print(f"old_jwt_len {len(old_jwt)}")

    env = ENV.read_text(encoding="utf-8")
    lines = env.splitlines()
    out = []
    found = False
    for line in lines:
        if line.startswith("ORG_ENCRYPTION_KEY="):
            out.append(f"ORG_ENCRYPTION_KEY={old_jwt}")
            found = True
        else:
            out.append(line)
    if not found:
        out.append(f"ORG_ENCRYPTION_KEY={old_jwt}")
    ENV.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("org_encryption_key_restored_from_bak_jwt")
    for key in ("JWT_SECRET", "ORG_ENCRYPTION_KEY", "NODE_ENV", "OPENAI_API_KEY"):
        present = any(l.startswith(f"{key}=") and len(l) > len(key) + 1 for l in out)
        print(key, "ok" if present else "MISSING")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
