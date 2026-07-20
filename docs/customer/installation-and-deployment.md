# Installation & Deployment

This guide is for whoever arranges GuideHerd's infrastructure for a firm —
usually GuideHerd staff or a firm's IT provider.

It covers the **decisions** a deployment involves and how to verify one is
working. It deliberately does not list configuration variable names: whoever is
actually typing those has the operator reference, and reproducing them here
would only create a second copy to drift.

If you administer your firm's *settings* rather than its infrastructure, you
want the [Administrator Guide](administrator-guide.md) instead.

---

## What runs

GuideHerd is a single service plus a set of static screens.

| Piece | What it is |
|---|---|
| **API service** | The application itself |
| **Configuration store** | Your firm's setup — practice areas, attorneys, settings |
| **Operational store** | Sessions, notification records, reminders |
| **Screens** | Reception Console, Operations Center, Administration |

The service starts even when little is configured. That's deliberate — an
incomplete deployment runs rather than refusing to boot, so capabilities can be
brought up one at a time.

---

## The four decisions

Every GuideHerd deployment answers these. Each has real consequences for the
firm, so decide them deliberately rather than by default.

### 1. Where does operational data live?

Sessions, notification records, and pending reminders are held either **in
memory** or in a **durable database**.

| | In memory | Durable database |
|---|---|---|
| Survives a restart | No | **Yes** |
| Pending reminders survive | No | **Yes** |
| Operations Center history survives | No | **Yes** |
| More than one instance possible | No | **Yes** |

**A durable database is the recommended configuration** and is what a firm
should expect. In-memory is appropriate only for a trial that nobody depends on.

If the service is misconfigured to use a database it cannot reach, it **stops
rather than starting** — deliberately. A service that silently reverted to
in-memory would lose bookings quietly, which is far worse than one that refuses
to start loudly.

### 2. How is the firm's configuration managed?

Two mutually exclusive modes, and **the choice must be made explicitly**:

- **Managed live** — the firm's setup is stored durably, and changes made in the
  Administration screen persist.
- **Rebuilt from a file at startup** — a setup document is re-imported every
  time the service restarts.

> **These modes cannot be mixed.** In file mode, **anything changed through the
> Administration screen is silently reverted at the next restart** — with no
> warning, and no way for an administrator to tell which mode they're in.
>
> Whoever deploys must tell the firm's administrator which mode is in use. Not
> knowing is how an afternoon of configuration disappears.

### 3. Is email configured?

Email delivery requires credentials for the mail system. Without them the
service runs normally but **sends nothing at all** — including the consultation
summary — and the Operations Center reports every delivery as `not-configured`.

**Verify email actually works before a firm relies on it.** A deployment that is
otherwise perfect but silently sends no email looks fine from every screen.

Note that the address email comes *from* is set here, at deployment. A firm's
configured sender name appears inside the message but does not change the From
address; email from the firm's own domain requires a firm-specific mailbox.

### 4. Does the Reception Console require sign-in?

Off by default — the console is open to anyone who can reach it, which is often
reasonable for a front-desk machine on an office network.

Turning it on is a **planned change, not a configuration tweak**: every
receptionist must be provisioned and individually verified first, or they cannot
work the moment it's on. There is a separate operational runbook for this, and
it includes rehearsing the rollback.

With the PostgreSQL operational provider (the standard production
configuration), **login sessions are stored durably** — restarts don't sign
people out, and multiple instances share the same sessions. With the
in-memory provider, sessions live in the process: a restart signs everyone
out and exactly one instance is supported.

---

## Verifying a deployment

Work through these in order; each depends on the ones above it.

1. **The service starts** and stays up.
2. **The Reception Console loads** and shows the firm's practice areas,
   attorneys, and consultation types. The "couldn't load scheduling options"
   error here means the configuration store is empty or unreachable — or the
   browser is being blocked from calling the API.
3. **A full session completes:** prepare, transfer, book. Use a real address you
   control.
4. **The confirmation email actually arrives.** Do not skip this — it is the
   step most often assumed rather than checked.
5. **The Operations Center loads** and shows the session just created.
6. **A restart behaves as expected** for the chosen storage — and confirm which
   behavior *is* expected before testing it.

Do all six before a real caller does them for you.

---

## Upgrades

Storage migrations apply automatically at startup. A failed migration stops the
service rather than starting it in an unknown state.

Before upgrading a production deployment:

1. Confirm a current backup exists (see below).
2. Deploy.
3. Re-run the verification list above.

---

## Backup and restore

**GuideHerd's software does not perform backups of its own.** Backup and restore
are properties of the storage the deployment is configured with — a managed
database typically provides automated backups and point-in-time recovery; a
plain file on a disk provides whatever the host provides and nothing more.

Because it depends on the deployment, it must be **established and recorded per
firm** rather than assumed:

- Is the firm's configuration backed up, and on what schedule?
- Is the operational database backed up, and does it support point-in-time
  recovery?
- **Has a restore ever actually been performed and verified?**

An untested backup is a hope, not a plan. Record the answers where the firm
keeps its continuity documentation, and give them to the firm's administrator —
they are told to ask.

---

## Data retention

**Automatic deletion of old caller data is not implemented.** Intended defaults
exist — clearing abandoned sessions after a day, removing caller contact details
from completed sessions after a month — but the job that would perform it has
not been built. Nothing is deleted automatically today.

A firm with a retention obligation needs a **written manual procedure**: who
deletes what, how often, and how. Agree it before the firm goes live, not after
someone asks.

Two points in GuideHerd's favor, true in every deployment: consultation
summaries are never stored (the delivered email is the only copy), and prepared
sessions expire in 10 minutes, so caller details do not linger in a pending
state.
