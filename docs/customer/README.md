# GuideHerd Documentation

Everything you need to run GuideHerd at your firm.

---

## Start here

**New to GuideHerd?** → **[Getting Started](getting-started.md)**
Fifteen minutes. What it does, who does what, and your first week.

---

## By role

### I answer the phones
→ **[Receptionist Guide](receptionist-guide.md)**

The Reception Console: preparing callers, transferring them, and what to do when
something doesn't go to plan. Written to be read in one sitting.

### I run GuideHerd for my firm
→ **[Administrator Guide](administrator-guide.md)**

Setting the firm up, managing people, notifications, backups, and your routine.
Start here, then use the Configuration Guide as a lookup.

### I watch what's happening
→ **[Operations Guide](operations-guide.md)**

The Operations Center: what's on it, what it can't tell you, and how to
investigate a specific call.

### I run the servers
→ **[Installation & Deployment](installation-and-deployment.md)**

Deploying and configuring the service. The one page that names actual
environment variables.

---

## By task

| I want to… | Guide |
|---|---|
| Understand what GuideHerd does | [Getting Started](getting-started.md) |
| Train a receptionist | [Receptionist Guide](receptionist-guide.md) |
| Set my firm up | [Administrator Guide](administrator-guide.md) |
| Change a setting | [Configuration Guide](configuration-guide.md) |
| Find out if I can change something myself | [Configuration Guide](configuration-guide.md) |
| Investigate a specific call | [Operations Guide](operations-guide.md) |
| Fix something that's wrong | [Troubleshooting Guide](troubleshooting-guide.md) |
| Look up a limit, status, or term | [Reference Guide](reference-guide.md) |
| Deploy or upgrade the service | [Installation & Deployment](installation-and-deployment.md) |

---

## All guides

| Guide | For |
|---|---|
| **[Getting Started](getting-started.md)** | Everyone, first |
| **[Installation & Deployment](installation-and-deployment.md)** | Whoever runs the infrastructure |
| **[Administrator Guide](administrator-guide.md)** | Whoever runs GuideHerd for the firm |
| **[Receptionist Guide](receptionist-guide.md)** | Whoever answers the phone |
| **[Operations Guide](operations-guide.md)** | Anyone monitoring activity |
| **[Configuration Guide](configuration-guide.md)** | Every setting, and who can change it |
| **[Troubleshooting Guide](troubleshooting-guide.md)** | When something looks wrong |
| **[Reference Guide](reference-guide.md)** | Lookup tables and glossary |

---

## Three things worth knowing early

Each is covered properly in the guides, but they cause enough trouble to say up
front.

**1. Check your firm's timezone before your first real call.**
It's the reference for every appointment time. Wrong, and everything still looks
correct — until a caller arrives at the wrong hour.

**2. Have receptionists read email addresses back to callers.**
A typo means a booked appointment the caller never hears about, and nobody finds
out until they don't show up. Five seconds prevents the most common failure in
the system.

**3. Nothing alerts you when something fails.**
A failed booking or a failed email is recorded, not announced. Checking the
Operations Center is the only detection there is. Make it a daily habit at
first.

---

## Getting help

Work through the [Troubleshooting Guide](troubleshooting-guide.md) first — it
covers what you can resolve yourself.

When you contact GuideHerd, have ready:

- What happened, in the receptionist's words
- Roughly when
- **The session ID or correlation ID** from the Operations Center — by far the
  most useful thing you can provide
- Whether it's happened before, and how often

---

*Writing or updating these guides? See
[Documentation Standards](documentation-standards.md).*
