# Configuration Authority Cutover (ADR-0022)

**Purpose:** switch a deployment from every-boot seed re-import to
live-authoritative configuration — administration edits that survive restarts
and deploys. Written for the current Railway production deployment; the shape
applies to any host.

**This runbook changes production. It is executed only with explicit human
approval, one step at a time, and it is reversible at every step.**

## Preconditions

- The release containing ADR-0022 (`GUIDEHERD_SEED_MODE`, the
  `configuration-authority` capability, and the Administration banner) is
  deployed and healthy.
- You can see the Operations Center health list (operator sign-in) and the
  Administration screen (administrator sign-in).
- You know the current state: no volume is attached, so the configuration
  store is rebuilt from `GUIDEHERD_SEED_FILE` at every boot and the health
  list shows `configuration-authority: bootstrap-imported` (a warning that
  never clears, because no restart ever finds a populated store).

## Why a volume is required

`bootstrap` mode only helps if the store file survives between boots. On an
ephemeral filesystem every boot starts empty, imports the seed, and loses any
edits made since — regardless of mode. Durable administration requires a
persistent disk for the SQLite configuration store.

## Steps

1. **Attach a volume** to the service (Railway: Volumes → attach; pick a
   mount path, e.g. `/data`). This triggers a redeploy.
2. **Point the store at the volume**: set `GUIDEHERD_CONFIG_DB` to a path on
   the mount (e.g. `/data/guideherd-config.db`). Leave `GUIDEHERD_SEED_FILE`
   set and `GUIDEHERD_SEED_MODE` unset (= `bootstrap`). Redeploy.
   - First boot on the volume: the store is empty, so the seed imports once.
     Health shows `configuration-authority: bootstrap-imported` — expected.
3. **Prove durability**: restart the service (no config change). After the
   restart, the boot log shows the "bootstrap skipped … live configuration is
   authoritative" line, and:
   - Operations Center: `configuration-authority: live` (ok badge).
   - Administration screen: green **Live** banner.
4. **Prove the acceptance criterion end-to-end**: make a harmless
   administration edit (e.g. change the organization display name), restart
   the service again, and confirm the edit is still there. Revert the edit.
5. **Optional hygiene**: once `live` is verified, `GUIDEHERD_SEED_FILE` may be
   unset for clarity. It is inert in `bootstrap` mode (the skip line proves
   it), so leaving it set is also safe — prefer unsetting so the variable
   list reflects reality.
6. **Update the deployment reference**: flip the "Current production
   configuration" table in `deployment-reference.md` and move ADR-0022 to
   Accepted.

## Timing / coordination

The import happens before the port binds, so there is no
partially-configured serving window. Do the cutover outside reception hours
anyway: step 1's redeploy restarts the service like any deploy. No
configuration can be lost mid-cutover — until step 3 proves `live`, the seed
document remains the effective source, and after it, the store is.

## Rollback

Every step is a variable change:

- Remove `GUIDEHERD_CONFIG_DB` (or set `GUIDEHERD_SEED_MODE=always`) to
  return to the previous behavior. No step deletes data; the volume file
  simply stops being used.

## Failure modes

- **Badge stays `bootstrap-imported` after step 3** — the store didn't
  survive the restart: verify the volume is mounted and
  `GUIDEHERD_CONFIG_DB` points inside the mount path.
- **Boot crash after step 2** — the seed document failed validation or the
  path is unwritable; the process exits non-zero by design. Check the crash
  log's structured error, fix, redeploy.
- **Unknown `GUIDEHERD_SEED_MODE` value** — refuses to start, by design.
