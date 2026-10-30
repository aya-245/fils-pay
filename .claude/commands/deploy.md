---
description: Redeploy FilsPay to the Dilmune VM safely (secrets by name only, no settlement interruption)
argument-hint: <user@host> <ssh-key-path>
---

1. `scripts/env-keys.sh check keys` — list missing key NAMES only; never print values.
2. `scripts/env-keys.sh build keys ops/.env.prod`.
3. Do not deploy while the settlement daemon is closing a day (00:00–00:45 Asia/Bahrain) unless told to;
   `scripts/deploy-vm.sh` refuses that window without `FORCE=1`.
4. `scripts/deploy-vm.sh $ARGUMENTS` — builds locally, ships images, migrates, restarts only changed services,
   smoke-tests /healthz, web and admin.
5. From outside: `curl -fsS https://<WEB_HOST>/api/healthz` and open checkout, dashboard and admin.
6. Record what was deployed (commit id) in `docs/audit/deploy.md`.
