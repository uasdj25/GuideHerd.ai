# Slot Selection API (ADR-0012 / #66)

The seam where provider availability becomes GuideHerd's offer. The
scheduling assistant's runtime fetches availability from its calendar
provider, translates it into the neutral slot contract, and asks GuideHerd
what to offer. Providers never learn policy; GuideHerd never fetches
availability.

> **Activation status (#66): implemented, NOT YET in the caller path.**
> No production or demo component calls this endpoint today — it is
> exercised only by its automated tests. Booking currently happens inside
> the scheduling assistant's external calendar tool (ADR-0011 §7), which
> must be configured (provider-side, no repository change) to call this
> seam and offer back what it returns. Until that is done and a real test
> call confirms policy-shaped offers, callers are offered raw provider
> availability and this endpoint changes nothing they experience.

## Request

`POST /api/v1/scheduling/slot-selection` — service identity (Bearer), the
`scheduling-assistant` role's `scheduling:select` permission. The
organization comes from the authenticated identity, never the body.

```json
{
  "slots": [
    { "startsAt": "2026-07-13T14:00:00Z", "durationMinutes": 30,
      "attorneyId": "clay-martinson", "consultationTypeId": "initial-consultation",
      "location": "huntsville" }
  ],
  "request": { "attorneyId": "clay-martinson", "consultationTypeId": "initial-consultation" },
  "sessionId": "optional, correlation only"
}
```

- `slots` — required array, at most 200 — and the request must fit the
  API's 16 KB body limit (roughly 100 typical slots; a week of real
  availability sits far below either bound). Unknown fields are dropped;
  malformed slots are dropped and counted, never fatal.
- `request` — the caller's own asks (outrank firm preferences in ranking).

## Response

```json
{
  "slots": [ { "startsAt": "…", "durationMinutes": 30, "attorneyId": "…", "score": 120, "matchedDimensions": ["…"] } ],
  "applied": {
    "policy": true,
    "dimensions": ["preferred-time-of-day"],
    "businessHours": "applied",
    "removedOutsideHours": 1,
    "unscopedSlots": 0,
    "droppedMalformed": 0,
    "fallback": { "requestedAttorneyUnavailable": false, "consultationTypeRelaxed": false }
  }
}
```

Ordering is deterministic: same availability + same policy → same order.
Business hours are a HARD rule (outside-hours slots are never returned;
an all-excluded offer is honestly empty and loudly telemetered);
preferences re-rank and preference filters relax rather than empty.

Errors: `400 validation_error` (non-array/oversized slots), `401`/`403`
(identity/permission), `503 config_unavailable` (no configuration store).
