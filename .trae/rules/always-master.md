---
description: Land finished work on master and push so production can update
alwaysApply: true
---

# Always land on master

When finishing work the user wants shipped (features, fixes, commits they asked to push):

1. **Commit on the working branch** as usual (or directly on `master` if they asked).
2. **Update `master`**: merge or cherry-pick the finished commits into `master` (fast-forward when clean).
3. **Push `origin master`** every time — do not stop after pushing only a feature branch (`cursor/…`).
4. Production is **https://app.sync2dine.io** (Plesk VPS). Pushing GitHub `master` alone does **not** refresh the live site — after pushing master, build with `.env.production.local` and deploy SPA via SSH host `vps` (`scripts/deploy-spa.sh` → docroot `…/app.sync2dine.io/`). Never publish into marketing `httpdocs/`. Docroot group must be `psaserv`; keep `.htaccess` Cache-Control values simply quoted (`no-cache`).
5. Prefer `master` as the long-lived integration branch. Feature branches are fine for WIP, but shipped work must reach `origin/master` in the same session unless the user says otherwise.
