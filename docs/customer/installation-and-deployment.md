# Installation & Deployment

This guide is for whoever runs GuideHerd's infrastructure — usually GuideHerd
staff or a firm's IT provider. If you administer your firm's *settings* rather
than its servers, you want the
[Administrator Guide](administrator-guide.md) instead.

Unlike the rest of this documentation, this page names the actual environment
variables, because the reader is the person setting them.

---

## What runs

GuideHerd is a single service plus a set of static screens.

| Piece | What it is |
|---|---|
| **API service** | Node.js, listens on `PORT` (default `3000`) |
| **Configuration store** | SQLite file — your firm's setup |
| **Operational store** | In-memory, or PostgreSQL for durability |
| **Screens** | Static pages — Reception Console, Operations Center, Administration |

Requires Node.js 22.5 or later.

---

## Minimum viable deployment

The service starts with almost nothing configured. That's deliberate — an
unconfigured GuideHerd runs rather than refusing to boot, so you can bring
capabilities up one at a time.

```bash
cd server
npm start
```

What you get with no configuration: the API runs, the console loads, and
scheduling options come from the configuration store. What you *don't* get:
email delivery, durable sessions, or authenticated sign-in.

---

## Core settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Listen port |
| `CORS_ALLOWED_ORIGINS` | `https://guideherd.ai,http://localhost:8080` | Browser origins allowed to call the API. Exact matches only — wildcards are ignored. |
| `GUIDEHERD_CONFIG_DB` | `./guideherd-config.db` | Path to the configuration store. Migrations apply automatically at boot. |

**If the Reception Console can't reach the API, check `CORS_ALLOWED_ORIGINS`
first.** It is the most common deployment mistake, because the failure looks
like a network problem rather than a configuration one.

---

## Choosing where sessions live

`GUIDEHERD_OPERATIONAL_PROVIDER` selects the operational store:

- **`memory`** (default) — sessions live in process memory. A restart clears
  them. Fine for a single instance and a pilot.
- **`postgres`** — durable sessions in PostgreSQL. Required for more than one
  instance.

With `postgres`, supply a connection string via `DATABASE_URL` (Railway injects
this when a PostgreSQL service is linked) or
`GUIDEHERD_OPERATIONAL_DATABASE_URL` (which wins if both are set).

**There is no silent fallback, by design.** Selecting `postgres` with an
unreachable database, a failed migration, or no connection string makes the
process **exit rather than start**. An unknown value does the same. A service
that won't start is a loud, obvious failure; a service that silently reverted to
in-memory sessions would lose bookings quietly.

**Rollback:** set it back to `memory` and redeploy.

`GUIDEHERD_PG_POOL_MAX` (default `5`) sets the connection pool per instance.
Keep the sum across all instances under your database plan's connection limit.

---

## Email delivery

Email goes out through Microsoft Graph. **All five of these must be present or
the mailer stays disabled:**

```
MS_TENANT_ID
MS_CLIENT_ID
MS_CLIENT_SECRET
SUMMARY_MAILBOX
SUMMARY_RECIPIENT
```

With any missing, the API starts normally and reports delivery as
`not-configured` rather than failing. This is intentional: **a mail failure
never reverses a confirmed appointment.** Booking and notification are separate
outcomes, so a mail outage costs you notifications, not bookings.

`NOTIFICATION_MAILBOX` sets the sending mailbox (falling back to
`SUMMARY_MAILBOX`).

**Note on sender identity:** the address emails come *from* is this mailbox — a
deployment setting. A firm's configured sender name appears in the subject and
body, but does **not** change the From address. If a firm needs email to come
from its own domain, that requires a firm-specific mailbox at deployment time.
It is not something a firm administrator can configure.

---

## Setting up a firm's configuration

The configuration store holds each firm's setup. How you populate it depends on
whether your filesystem survives a restart.

**With a persistent disk** (a real filesystem, or an attached volume): the
database persists. Seed it once and leave `GUIDEHERD_SEED_FILE` unset.

**With an ephemeral filesystem** (a container with no volume attached): the
database is lost on every restart. Set `GUIDEHERD_SEED_FILE` to a seed document
so the firm's setup is rebuilt at boot.

> **Plan for this deliberately.** On an ephemeral filesystem without a seed
> file, a restart leaves a firm with no practice areas, attorneys, or
> consultation types — and the Reception Console will show its "couldn't load
> scheduling options" error to every receptionist. Attach a volume or set a seed
> file. Do not rely on the store surviving by luck.

Some setup is **seed-file-only today** — consultation types, routing groups and
their practice-area assignments. There is no administration screen for these, so
changing them means editing the seed or configuration directly. See the
[Configuration Guide](configuration-guide.md) for what is and isn't
administrable.

---

## Sign-in (optional, off by default)

`GUIDEHERD_CONSOLE_AUTH` controls whether the Reception Console requires a
sign-in:

- **`anonymous`** (default) — no sign-in. The console is open to anyone who can
  reach it.
- **`required`** — receptionists must sign in.

Any other value refuses to boot.

**Enabling this is a deliberate, planned change, not a config tweak.** Turning
it on immediately gates every receptionist, and an unprovisioned receptionist
cannot work. Users must be provisioned and individually verified *before* the
switch, and the rollback should be rehearsed first.

Follow the operational runbook rather than doing it from this page.

Related settings: `GUIDEHERD_DEV_USERS` (provisioned users),
`GUIDEHERD_USER_AUTH_PROVIDER`, `GUIDEHERD_USER_SESSION_TTL_SECONDS`
(default 8 hours, absolute — not extended by activity).

**Sessions are held in memory.** A restart signs everyone out, and more than one
instance will not work correctly with sign-in enabled until durable session
storage is in place.

---

## Other settings

| Variable | Default | What it does |
|---|---|---|
| `GUIDEHERD_MAX_PREPARED_SESSIONS` | `20` | Concurrent prepared sessions per firm. Exceeding it returns a "too many prepared sessions" error. |
| `GUIDEHERD_OUTBOX_POLL_INTERVAL_MS` | — | How often queued work (notifications, reminders) is drained |
| `DEMO_BRIDGE_SECRET` | — | Demo infrastructure only. **Not production authentication.** Unset leaves those endpoints returning a controlled error. |

---

## Verifying a deployment

Work through these in order. Each one depends on the ones above it.

1. **The service starts** and stays up.
2. **The Reception Console loads** and shows practice areas, attorneys, and
   consultation types. If it shows the options error, the configuration store is
   empty or unreachable — or CORS is wrong.
3. **A full session completes:** prepare, transfer, book. Use your own email.
4. **The confirmation arrives.** If not, check the five `MS_*` variables and the
   Operations Center's notification view.
5. **The Operations Center loads** and shows the session you just created.
6. **A restart behaves as you expect** — which, with `memory`, means active
   sessions are cleared.

Do all six before a real caller does them for you.

---

## Upgrades

Configuration store migrations apply automatically at boot. Operational store
migrations apply on start when using `postgres`; a failed migration stops the
process rather than starting in an unknown state.

Before upgrading a production deployment:

1. Back up the configuration store file (and the PostgreSQL database if used).
2. Deploy.
3. Re-run the verification list above.

**On backups: there is no automated backup built into GuideHerd.** Backing up
the configuration store file and the operational database is your
responsibility, through whatever your hosting platform provides. See
[Backup and recovery](administrator-guide.md#backup-and-recovery).
