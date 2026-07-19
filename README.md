# GuideHerd

GuideHerd builds AI front-office capabilities for professional-services firms.
The first product is receptionist-assisted scheduling for law firms.

This repository holds the GuideHerd marketing site, product demos, and the
project's architecture documentation.

## What's here

- **Website** — `index.html`, `about.html`, `approach.html`, `services.html`,
  `training.html`, deployed as a static site (see `.github/workflows/`).
- **Scheduling Assistant demo** — `demo/martinson-beason/`, a GuideHerd-branded
  scheduling experience.
- **Legal intake demo** — `legal-intake-demo.html` with supporting material in
  `docs/legal-intake/`, `data/`, and `scripts/`.
- **Documentation** — architecture, vision, and roadmap (below).

## Architecture

Start with **[ARCHITECTURE.md](ARCHITECTURE.md)** — it's short and required
reading for contributors. In one line:

> Every external dependency should hide behind a GuideHerd service.

- [ARCHITECTURE.md](ARCHITECTURE.md) — platform model, principles, and domain language
- [docs/Vision.md](docs/Vision.md) — what GuideHerd is building and why
- [docs/Roadmap.md](docs/Roadmap.md) — direction through October 2026
- [docs/architecture-decisions/](docs/architecture-decisions/) — architecture decision records
- [docs/customer/](docs/customer/) — customer documentation (administrator, receptionist,
  operations, configuration, troubleshooting, reference)
- [docs/developer/](docs/developer/) — developer documentation (architecture overview,
  local development, extension points, testing standards)
