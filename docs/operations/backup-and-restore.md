# Backup and Restore (GitLab #62)

**Status of this document:** the policy below is PROPOSED and versioned here;
its owner is DJ. One full restore of each store has been **performed and
verified** (evidence in §6) against isolated scratch environments — never
production data. The two production items that only the Railway dashboard can
answer are called out explicitly in §2 and §7.

## 1. What exists, and what needs backing up

| Store | Technology | Where it lives in production | Loss impact | Backup approach |
|---|---|---|---|---|
| Operational store | PostgreSQL | Railway template Postgres service, data on volume `postgres-volume` (mounted `/var/lib/postgresql/data`, 157 MB/5 GB used at time of writing) | Handoff sessions, delivery/claim records, outbox, workflow state — operational history and in-flight work | Railway **volume backups** + periodic logical dump (§3) |
| Configuration store | SQLite file | **Ephemeral today** (no app volume; rebuilt from the seed file at every boot). Post-cutover (#59 runbook): a file on an app volume | Firm configuration + administration audit trail | `VACUUM INTO` snapshot + off-host copy (§4); until the cutover, git's seed document IS the recovery source |
| User sessions | In-memory | Process memory | Everyone signs in again | **None, by design** — re-login is the documented recovery |
| Code, seed documents, static site | git | GitHub | — | git is its own backup |

GuideHerd performs no backups of its own — backup/restore are properties of
the configured storage. That is the architecture working as documented, not a
gap; this document supplies the operational half.

## 2. Production reality check (read-only inspection, 2026-07-19)

Performed with names/metadata only — no values, no data:

- `railway volume list`: exactly one volume, `postgres-volume`, attached to
  the Postgres service, mount `/var/lib/postgresql/data`, 157 MB/5000 MB,
  Ready. **The operational database is volume-backed template Postgres, not
  a managed-database product** — so its backups are Railway *volume backups*
  (a dashboard feature), not a managed-DB backup/PITR offering.
- The Railway **CLI exposes no backup commands at all** (full command
  inventory checked). Backup schedule, retention, and the existence of any
  volume snapshots can only be confirmed in the Railway dashboard —
  **owner action required, recorded in §7.**
- No app-service volume exists → the configuration store is ephemeral, as
  #59 found. Until the #59 cutover runbook is executed, the configuration
  "backup" is the seed document in git, and administration edits are not
  durable — so there is nothing durable to back up yet.

**Point-in-time recovery: NOT available** on this topology (volume snapshots
are point-in-time-of-snapshot only; WAL archiving is not configured). If PITR
becomes a requirement, that is a platform change (managed PG with PITR or
WAL-G to object storage) — a decision, not a checkbox.

## 3. Operational store (PostgreSQL) — policy

- **Primary mechanism:** Railway volume backups of `postgres-volume`.
  Proposed cadence: **daily**, retention **7 daily + 4 weekly** (adjust to
  the plan's limits once confirmed in the dashboard).
- **Secondary (platform-independent) mechanism:** a periodic logical dump
  taken with `pg_dump` from any machine with PostgreSQL client tools,
  stored off-Railway (encrypted at rest, access limited to the owner):
  `pg_dump --format=custom --file=guideherd-YYYYMMDD.dump "$DATABASE_URL"`
  — run via `railway run` or with the connection string handled per the
  standing secrets rule (never echoed, never in shell history files).
  Proposed cadence: **weekly**, retention 4.
- **Restore procedure (production):**
  1. Provision a scratch PostgreSQL (new Railway service or local).
  2. `pg_restore --clean --if-exists --no-owner -d <scratch-url> <dumpfile>`
     (volume-backup path: restore the volume snapshot onto a new service
     from the dashboard).
  3. Point a scratch app instance at it (`GUIDEHERD_OPERATIONAL_PROVIDER=
     postgres`, scratch URL); boot must succeed and the Operations Center
     must show the restored sessions.
  4. Only after verification, and only with explicit approval, repoint or
     promote. Never restore over the live database in place.
- **RPO (proposed):** 24 h (daily volume backup). **RTO (proposed):** 1 h
  (restore volume snapshot to a new service + repoint `DATABASE_URL`).
  Both are proposals until the dashboard confirms the backup cadence.

## 4. Configuration store (SQLite) — policy (effective after the #59 cutover)

- **Mechanism:** `VACUUM INTO` produces a consistent snapshot of the LIVE
  database with no downtime and no lock ceremony:
  `sqlite3 /data/guideherd-config.db "VACUUM INTO '/data/backups/config-YYYYMMDD.db'"`
  then copy the snapshot off-host (`railway ssh`/`railway volume files`, or
  a small scheduled job). Proposed cadence: **daily snapshot, retain 14**,
  plus one before every administration session that makes bulk changes.
- **Restore procedure:** stop the service (or accept the boot-time cutover),
  copy the snapshot to the `GUIDEHERD_CONFIG_DB` path, start, verify:
  scheduling options serve, the Administration screen shows the expected
  configuration and version history. ~minutes, file-copy speed.
- **Interim (pre-cutover):** the seed document in git is the configuration
  backup, restore = redeploy. This is exactly the mode's documented
  behavior; the audit trail is NOT covered in this mode (it lives in the
  ephemeral file) — one more reason the cutover matters.
- **RPO (proposed):** 24 h. **RTO (proposed):** 15 min.

## 5. Encryption, access, failure handling

- Off-host copies live only in owner-controlled storage with encryption at
  rest; no third-party service beyond the hosting already in use. Backup
  artifacts contain caller PII (operational store) and firm configuration —
  treat them with production-data discipline; never attach them to tickets,
  chats, or transcripts.
- Access: the owner (DJ). No standing credentials in CI or automation until
  a scheduled-backup job is deliberately provisioned.
- A FAILED backup is a loud finding, not a skipped chore: if a scheduled
  backup fails or a snapshot is missing, treat it as an open incident until
  the next verified-good backup exists.
- **Restore rehearsal cadence: quarterly**, and after any schema-shaped
  change to either store. Record each rehearsal in §6's format.

## 6. Restore rehearsal record — PERFORMED

**2026-07-19, local scratch environments, synthetic data only** (test-fixture
sessions; no production data was used as test data). Harness: temp dirs,
embedded PostgreSQL instances on random localhost ports, torn down after.

- Configuration store: seeded live store + one administration-style edit →
  `VACUUM INTO` backup of the LIVE db (**2 ms**, 143 KB) → original deleted →
  backup copied into place → **the real server booted against the restored
  file and served scheduling options (200, 8 practice areas) in 238 ms**;
  the post-seed administration edit survived the cycle.
- Operational store: real migrations + 5 synthetic sessions written through
  the app's own PostgreSQL store → logical dump of all 10 public tables
  (**5 ms**, 11 rows) → restore into a FRESH instance (application
  migration path + data + sequence repair, **48 ms**) → the app's store
  layer read back all 5 sessions **and accepted new writes** (sequence
  repair proven). End-to-end rehearsal wall time: **2.2 s**.
- The rehearsal is repeatable as **one command: `npm run rehearse:restore`**
  (`server/scripts/restore-rehearsal.js`) — run it quarterly and after any
  schema-shaped change, and paste its `REHEARSAL RECORD` block here.
- Caveat recorded honestly: no `pg_dump` binary exists on this machine (the
  embedded-postgres dev package ships only initdb/pg_ctl/postgres), so the
  local rehearsal used an equivalent logical dump/restore. The production
  procedure in §3 uses real `pg_dump`/`pg_restore`; the first production-
  shaped rehearsal (volume snapshot → new service) is a dashboard action —
  §7.

## 7. Owner actions (only DJ can do these)

1. **Railway dashboard:** confirm whether volume backups are enabled for
   `postgres-volume`; record schedule + retention here (replacing
   "proposed" above). If not enabled, enable them.
2. **One production-shaped restore:** restore the most recent volume
   backup/snapshot onto a scratch service and verify per §3 step 3. Record
   it in §6's format.
3. After the #59 cutover: schedule the configuration snapshot job (§4).

## 8. The answers the customer Administrator Guide promises

- *Is my firm's configuration backed up? On what schedule?* — Today:
  the configuration source document is version-controlled (git); the live
  administration mode's durability work is in progress, and daily snapshots
  begin with it (§4). Until then, treat administration edits per the
  Configuration Guide's banner guidance.
- *Is the operational database backed up, with point-in-time recovery?* —
  It lives on a persistent volume; scheduled volume backups are being
  confirmed/enabled (§7.1). **Point-in-time recovery: no** (§2) — snapshots
  restore to their capture moment.
- *Has a restore actually been performed and verified?* — **Yes**, once per
  store, 2026-07-19, in isolated scratch environments (§6); a
  production-shaped rehearsal is scheduled as §7.2.
