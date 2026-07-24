'use strict';

/**
 * The Calendar Provider conformance suite (ADR-0024 / GitLab #75) — the
 * certification bar every calendar provider implementation must pass.
 *
 * The suite runs against a HARNESS, not an implementation: the reference
 * provider exposes the harness surface directly; a real provider (e.g.
 * Microsoft Graph) wraps its mocked transport in the same surface. That
 * keeps every provider honest to the same behavioral guarantees:
 *
 *   makeHarness() -> {
 *     provider,                      the contract implementation under test
 *     givenCalendar(ref, opts),      seed a calendar (displayName, writable, busy)
 *     injectFailure(operation, kind) one-shot fault for the next call
 *     attempts(operation),           transport attempts observed
 *     eventsOn(ref),                 provider-side events incl. correlationId
 *   }
 *
 * All data is synthetic. No suite test performs IO.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCalendarProvider,
  CalendarUnavailableError,
  CalendarWriteRejectedError,
  CalendarWriteUnverifiedError,
} = require('./calendar-provider');

const WINDOW = {
  startUtcMs: Date.parse('2026-09-01T00:00:00Z'),
  endUtcMs: Date.parse('2026-09-08T00:00:00Z'),
};
const CAL = 'attorney-1-calendar';
const EVENT_ARGS = {
  calendarRef: CAL,
  startsAt: '2026-09-01T14:00:00.000Z',
  durationMinutes: 30,
  summary: 'Initial Consultation',
  correlationId: 'bc_11111111-2222-3333-4444-555555555555',
};
const SANITIZED_KEYS = ['providerEventId', 'startsAt', 'status'];

function runCalendarProviderContractSuite(label, makeHarness) {
  test(`${label}: implements the full contract shape`, async () => {
    const { provider } = await makeHarness();
    assert.ok(isCalendarProvider(provider), 'provider must expose key, configured, and all operations');
  });

  test(`${label}: discovery lists seeded calendars with capabilities and nothing else`, async () => {
    const h = await makeHarness();
    h.givenCalendar('cal-rw', { displayName: 'Read-write', writable: true });
    h.givenCalendar('cal-ro', { displayName: 'Read-only', writable: false });
    const found = await h.provider.discoverCalendars();
    const byRef = Object.fromEntries(found.map((c) => [c.calendarRef, c]));
    assert.deepEqual(byRef['cal-rw'], {
      calendarRef: 'cal-rw', displayName: 'Read-write', capabilities: { read: true, write: true },
    });
    // Providers may model write restriction differently (a split
    // capability, or an all-or-nothing access policy) — the contract rule
    // is NEVER OVERCLAIM: a restricted calendar must not report write.
    assert.equal(byRef['cal-ro'].capabilities.write, false,
      'a write-restricted calendar never claims write capability');
    for (const entry of found) {
      assert.deepEqual(Object.keys(entry).sort(), ['calendarRef', 'capabilities', 'displayName']);
    }
  });

  test(`${label}: busy intervals are normalized — window-scoped, sorted, ISO, end after start`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {
      busy: [
        { startsAt: '2026-09-02T16:00:00Z', endsAt: '2026-09-02T17:00:00Z' },
        { startsAt: '2026-09-01T14:00:00Z', endsAt: '2026-09-01T15:00:00Z' },
        // Entirely outside the window: must not appear.
        { startsAt: '2026-10-01T14:00:00Z', endsAt: '2026-10-01T15:00:00Z' },
      ],
    });
    const { intervals } = await h.provider.fetchBusyIntervals({ calendarRef: CAL, ...WINDOW });
    assert.equal(intervals.length, 2);
    let previous = -Infinity;
    for (const interval of intervals) {
      assert.equal(interval.startsAt, new Date(interval.startsAt).toISOString(), 'ISO-8601 UTC');
      assert.ok(Date.parse(interval.endsAt) > Date.parse(interval.startsAt), 'end after start');
      assert.ok(Date.parse(interval.startsAt) >= previous, 'sorted by start');
      previous = Date.parse(interval.startsAt);
    }
  });

  test(`${label}: a failed read FAILS CLOSED in one attempt — no partial data, no retry`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    h.injectFailure('fetchBusyIntervals', 'timeout');
    const before = h.attempts('fetchBusyIntervals');
    await assert.rejects(
      h.provider.fetchBusyIntervals({ calendarRef: CAL, ...WINDOW }),
      (err) => err instanceof CalendarUnavailableError && err.code === 'calendar_unavailable',
    );
    assert.equal(h.attempts('fetchBusyIntervals') - before, 1, 'exactly one transport attempt');
  });

  test(`${label}: an unknown calendar is a fail-closed read, not empty availability`, async () => {
    const h = await makeHarness();
    await assert.rejects(
      h.provider.fetchBusyIntervals({ calendarRef: 'no-such-calendar', ...WINDOW }),
      (err) => err instanceof CalendarUnavailableError && err.detail === 'calendar_not_accessible',
    );
  });

  test(`${label}: createEvent confirms with a sanitized result and durable correlation`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    const { providerEventId, sanitized } = await h.provider.createEvent(EVENT_ARGS);
    assert.ok(providerEventId);
    assert.deepEqual(Object.keys(sanitized).sort(), [...SANITIZED_KEYS].sort(),
      'sanitized subset only — never a raw provider payload');
    // Correlation is durably on the provider-side event…
    const stored = h.eventsOn(CAL).find((e) => e.providerEventId === providerEventId);
    assert.equal(stored.correlationId, EVENT_ARGS.correlationId);
    // …and reconciliation can find it by correlation alone.
    const found = await h.provider.findEventByCorrelation({
      calendarRef: CAL, correlationId: EVENT_ARGS.correlationId, ...WINDOW,
    });
    assert.equal(found.providerEventId, providerEventId);
    // The created event now occupies busy time.
    const { intervals } = await h.provider.fetchBusyIntervals({ calendarRef: CAL, ...WINDOW });
    assert.ok(intervals.some((i) => i.startsAt === EVENT_ARGS.startsAt));
  });

  test(`${label}: createEvent without a correlation id is refused before anything is written`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    await assert.rejects(
      h.provider.createEvent({ ...EVENT_ARGS, correlationId: '' }),
      (err) => err instanceof CalendarWriteRejectedError && err.detail === 'missing_correlation',
    );
    assert.equal(h.eventsOn(CAL).length, 0);
  });

  test(`${label}: a definitive provider rejection creates nothing and is never ambiguous`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    h.injectFailure('createEvent', 'reject');
    await assert.rejects(
      h.provider.createEvent(EVENT_ARGS),
      (err) => err instanceof CalendarWriteRejectedError,
    );
    assert.equal(h.eventsOn(CAL).length, 0);
  });

  test(`${label}: a write to an inaccessible or read-only calendar is a definitive rejection`, async () => {
    const h = await makeHarness();
    h.givenCalendar('cal-ro', { writable: false });
    for (const calendarRef of ['cal-ro', 'no-such-calendar']) {
      await assert.rejects(
        h.provider.createEvent({ ...EVENT_ARGS, calendarRef }),
        (err) => err instanceof CalendarWriteRejectedError && err.detail === 'calendar_not_accessible',
      );
    }
  });

  test(`${label}: an ambiguous write is surfaced, never retried, never coerced`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    h.injectFailure('createEvent', 'timeout');
    const before = h.attempts('createEvent');
    await assert.rejects(
      h.provider.createEvent(EVENT_ARGS),
      (err) => err instanceof CalendarWriteUnverifiedError && err.code === 'calendar_write_unverified',
    );
    assert.equal(h.attempts('createEvent') - before, 1,
      'exactly one transport attempt — an ambiguous write is NEVER retried');
  });

  test(`${label}: the ambiguous-but-created case is recoverable by correlation (reconciliation)`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    h.injectFailure('createEvent', 'ambiguous_created');
    await assert.rejects(
      h.provider.createEvent(EVENT_ARGS),
      (err) => err instanceof CalendarWriteUnverifiedError,
    );
    // The response was lost but the event exists — exactly what
    // verification_required reconciliation must be able to prove.
    const found = await h.provider.findEventByCorrelation({
      calendarRef: CAL, correlationId: EVENT_ARGS.correlationId, ...WINDOW,
    });
    assert.ok(found, 'reconciliation finds the event by correlation');
    assert.equal(found.status, 'confirmed');
  });

  test(`${label}: mutation requires correlation — a mismatch is refused with no change`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    const { providerEventId } = await h.provider.createEvent(EVENT_ARGS);
    for (const operation of ['updateEvent', 'cancelEvent']) {
      await assert.rejects(
        h.provider[operation]({
          calendarRef: CAL, providerEventId, correlationId: 'bc_someone-elses-booking',
          ...(operation === 'updateEvent' ? { startsAt: '2026-09-02T14:00:00.000Z' } : {}),
        }),
        (err) => err instanceof CalendarWriteRejectedError && err.detail === 'correlation_mismatch',
      );
    }
    const stored = h.eventsOn(CAL).find((e) => e.providerEventId === providerEventId);
    assert.equal(stored.startsAt, EVENT_ARGS.startsAt, 'event unmodified');
    assert.equal(stored.status, 'confirmed');
  });

  test(`${label}: updateEvent moves the event; cancelEvent frees its busy time`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    const { providerEventId } = await h.provider.createEvent(EVENT_ARGS);
    const moved = await h.provider.updateEvent({
      calendarRef: CAL, providerEventId, correlationId: EVENT_ARGS.correlationId,
      startsAt: '2026-09-02T15:00:00.000Z',
    });
    assert.equal(moved.sanitized.startsAt, '2026-09-02T15:00:00.000Z');
    const { sanitized } = await h.provider.cancelEvent({
      calendarRef: CAL, providerEventId, correlationId: EVENT_ARGS.correlationId,
    });
    assert.equal(sanitized.status, 'cancelled');
    const { intervals } = await h.provider.fetchBusyIntervals({ calendarRef: CAL, ...WINDOW });
    assert.equal(intervals.length, 0, 'cancelled events do not occupy busy time');
  });

  test(`${label}: mutating a nonexistent event is a definitive rejection`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    await assert.rejects(
      h.provider.cancelEvent({ calendarRef: CAL, providerEventId: 'no-such-event', correlationId: 'bc_x' }),
      (err) => err instanceof CalendarWriteRejectedError && err.detail === 'event_not_found',
    );
  });

  test(`${label}: an ambiguous cancel is unverified — the caller must reconcile, never assume`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    const { providerEventId } = await h.provider.createEvent(EVENT_ARGS);
    h.injectFailure('cancelEvent', 'network');
    await assert.rejects(
      h.provider.cancelEvent({ calendarRef: CAL, providerEventId, correlationId: EVENT_ARGS.correlationId }),
      (err) => err instanceof CalendarWriteUnverifiedError,
    );
  });

  test(`${label}: reconciliation absence is null, not an error`, async () => {
    const h = await makeHarness();
    h.givenCalendar(CAL, {});
    const found = await h.provider.findEventByCorrelation({
      calendarRef: CAL, correlationId: 'bc_never-created', ...WINDOW,
    });
    assert.equal(found, null);
  });
}

module.exports = { runCalendarProviderContractSuite };
