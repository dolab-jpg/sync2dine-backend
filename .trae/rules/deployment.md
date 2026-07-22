---
description: Sync2Dine repos, git push, and Supabase deploy — do not scan the machine for credentials
alwaysApply: true
---

# Sync2Dine deployment and auth

## Repos and paths

| Role | Local path | GitHub remote | Branch |
|------|------------|---------------|--------|
| Frontend | `c:\Users\dolab\Downloads\sync2dine-frontend` | `https://github.com/dolab-jpg/sync2dine-frontend.git` | `master` |
| Backend | `c:\Users\dolab\Downloads\sync2dine-backend` | `https://github.com/dolab-jpg/sync2dine-backend.git` | `master` |

GitHub account: **dolab-jpg**. Auth is in Windows Credential Manager (`git:https://github.com`). Do not embed tokens in commits or rules. Do not search `%USERPROFILE%` or Downloads for secrets.

## Git

```powershell
cd "c:\Users\dolab\Downloads\sync2dine-frontend"
git push origin master

cd "c:\Users\dolab\Downloads\sync2dine-backend"
git push origin master
```

## Supabase (Trae MCP)

This project has `.trae/mcp.json` pointing at the Sync2Dine Supabase project. In Trae: **Settings → MCP** → ensure `supabase` is green → use **Builder with MCP**. Connect/authenticate in Trae’s UI; do not paste PATs into committed files.

Machine-local tokens (if any) live in gitignored `.cursor/local/deploy.env` — reuse those; do not create a second secret scheme for Trae.

## What not to do

- Do not commit `.env.local`, `deploy.env`, or access tokens
- Do not create new GitHub repos unless the user asks
- Do not invent new env files for Trae — reuse existing product env files
