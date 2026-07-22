# Trae + Cursor on this repo

Project: **sync2dine-backend**

Cursor and Trae share this Git working tree and existing env files.

## Open in Trae

```powershell
cd "c:\Users\dolab\Downloads\sync2dine-backend"
trae .
```

## Layout

- Rules: `.trae/rules/shared.md`
- Product env: existing project env files only (no Trae-only secrets)
- MCP: add `.trae/mcp.json` only if this repo already uses Cursor MCP

## Shared Git

Save before editing the same file in the other IDE. Use one `git status` / `git diff`.
