---
description: Prefer mainline branch for shipped work; do not invent secrets
alwaysApply: true
---

# Shared Cursor + Trae habits

1. Cursor and Trae edit the **same** Git working tree — save before cross-editing the same file.
2. Reuse existing project env files (`.env`, `.env.local`, etc.). Do **not** create Trae-only product secrets.
3. Do not commit access tokens, PATs, or credential files.
4. When the user asks to ship, land work on the repo’s mainline branch (`master` or `main`) and push that remote unless they say otherwise.
5. Do not scan the machine for credentials or invent new remotes.
