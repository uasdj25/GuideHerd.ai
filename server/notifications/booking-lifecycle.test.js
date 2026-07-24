'use strict';

/**
 * Booking lifecycle notifications (GitLab #88): default-off enablement,
 * exactly-once keys shared across trigger paths, ICS attachments through
 * the real service, the Graph attachment mapping, and the
 * provider-invitation policy default.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { openDatabase } = require('../config/db');
const { migrate } = require('../config/migrate');
const { createConfigService } = require('../config/service');
const { fixedClock } = require('../handoff/clock');
const { sendBookingLifecycleNotification } = require('./booking-lifecycle');
const { buildAppointmentIcs } = require('./ics');
const { createNotificationService } = require('./service');
const { createNotificationProviderRegistry } = require('./contract');
const { createInMemoryNotificationDeliveryStore } = require('./delivery-store');
const { createGraphEmailProvider } = require('./graph-email-provider');

const FIRM = 'firm-a';
const T0 = Date.parse('2026-08-30T15:00:00Z');
const SLOT = '2026-09-01T14:00:00.000Z';

function fixture({ enabled = true } = {}) {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Firm A', timezone: 'America/Chicago' });
  configService.providers.create(FIRM, { key: 'clay-martinson', name: 'clay', displayName: 'Clay Martinson', active: true });
  configService.consultationTypes.create(FIRM, { key: 'initial-consultation', name: 'Initial Consultation', active: true });
  if (enabled) configService.settings.set(FIRM, 'notifications', 'appointment-confirmation', { enabled: true });
  const sent = [];
  const notifications = { async send(request, context) { sent.push({ request, context }); return { status: 'sent' }; } };
  return { db, configService, notifications, sent };
}

const CONTEXT = {
  bookingContextId: 'bc_1', sessionId: null, attorneyId: 'clay-martinson',
  consultationTypeId: 'initial-consultation', selectedStartsAt: SLOT, durationMinutes: 30,
};

test('lifecycle: DEFAULT OFF — no tenant gets appointment email until it explicitly opts in', async () => {
  const fx = fixture({ enabled: false });
  const result = await sendBookingLifecycleNotification({
    notifications: fx.notifications, configService: fx.configService, organizationKey: FIRM,
    kind: 'booked', bookingContext: CONTEXT, recipient: { name: 'Pat', email: 'pat@example.com' },
  });
  assert.deepEqual(result, { status: 'skipped_disabled' });
  assert.equal(fx.sent.length, 0);
  fx.db.close();
});

test('lifecycle: booked/cancelled/rescheduled map to the contract types with the booking identity as the key', async () => {
  const fx = fixture();
  for (const [kind, type] of [
    ['booked', 'appointment-confirmation'],
    ['cancelled', 'appointment-cancellation'],
    ['rescheduled', 'appointment-rescheduled'],
  ]) {
    await sendBookingLifecycleNotification({
      notifications: fx.notifications, configService: fx.configService, organizationKey: FIRM,
      kind, bookingContext: CONTEXT, recipient: { name: 'Pat', email: 'pat@example.com' },
    });
    const { request } = fx.sent.at(-1);
    assert.equal(request.type, type);
    assert.equal(request.notificationKey, `${type}:bc_1`);
    assert.deepEqual(request.appointment, {
      startsAt: SLOT, timezone: 'America/Chicago', durationMinutes: 30,
      attorneyName: 'Clay Martinson', consultationType: 'Initial Consultation',
    });
  }
  // Session-linked bookings use the SESSION identity — the same key the
  // conversation-outcome trigger uses, so the two paths dedupe.
  await sendBookingLifecycleNotification({
    notifications: fx.notifications, configService: fx.configService, organizationKey: FIRM,
    kind: 'booked', bookingContext: { ...CONTEXT, sessionId: 'sess-9' },
    recipient: { email: 'pat@example.com' },
  });
  assert.equal(fx.sent.at(-1).request.notificationKey, 'appointment-confirmation:sess-9');
  fx.db.close();
});

test('lifecycle: a missing recipient is a visible skip, never a crash and never silence', async () => {
  const fx = fixture();
  const result = await sendBookingLifecycleNotification({
    notifications: fx.notifications, configService: fx.configService, organizationKey: FIRM,
    kind: 'cancelled', bookingContext: CONTEXT, recipient: null,
  });
  assert.deepEqual(result, { status: 'skipped_no_recipient' });
  assert.equal(fx.sent.length, 0);
  fx.db.close();
});

test('ICS: request/cancel methods, UTC instants, sequence bump, and text escaping', () => {
  const ics = buildAppointmentIcs({
    uid: 'guideherd-bc_1', startsAt: SLOT, durationMinutes: 30,
    summary: 'Initial Consultation with Clay Martinson; Firm, P.C.',
    method: 'REQUEST', sequence: 0, nowMs: T0,
  });
  assert.equal(ics.filename, 'appointment.ics');
  assert.match(ics.content, /METHOD:REQUEST/);
  assert.match(ics.content, /DTSTART:20260901T140000Z/);
  assert.match(ics.content, /DTEND:20260901T143000Z/);
  assert.match(ics.content, /SUMMARY:Initial Consultation with Clay Martinson\\; Firm\\, P\.C\./);
  assert.match(ics.content, /STATUS:CONFIRMED/);

  const cancel = buildAppointmentIcs({
    uid: 'guideherd-bc_1', startsAt: SLOT, summary: 'x', method: 'CANCEL', sequence: 1, nowMs: T0,
  });
  assert.equal(cancel.filename, 'cancellation.ics');
  assert.match(cancel.content, /METHOD:CANCEL/);
  assert.match(cancel.content, /STATUS:CANCELLED/);
  assert.match(cancel.content, /SEQUENCE:1/);
});

test('service: appointment notifications carry the ICS attachment to the provider', async () => {
  const db = openDatabase();
  migrate(db);
  const configService = createConfigService({ db });
  configService.organizations.create({ key: FIRM, name: 'Firm A', timezone: 'America/Chicago' });
  const delivered = [];
  const registry = createNotificationProviderRegistry();
  registry.register({
    providerKey: 'graph-email',
    async deliver(message) { delivered.push(message); return { status: 'sent' }; },
  });
  const service = createNotificationService({
    registry, deliveryStore: createInMemoryNotificationDeliveryStore({ clock: fixedClock(T0) }), configService,
  });
  await service.send({
    type: 'appointment-cancellation', organizationKey: FIRM,
    notificationKey: 'appointment-cancellation:bc_7',
    recipient: { email: 'pat@example.com' },
    appointment: { startsAt: SLOT, timezone: 'America/Chicago', durationMinutes: 45, attorneyName: 'Clay Martinson' },
  });
  assert.equal(delivered.length, 1);
  const [attachment] = delivered[0].attachments;
  assert.equal(attachment.filename, 'cancellation.ics');
  assert.match(attachment.content, /UID:guideherd-bc_7/);
  assert.match(attachment.content, /DTEND:20260901T144500Z/, 'durationMinutes drives DTEND');
  db.close();
});

test('graph email provider: attachments map to Graph fileAttachment with base64 content', async () => {
  const requests = [];
  const provider = createGraphEmailProvider({
    env: {
      MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', SUMMARY_MAILBOX: 'mail@firm.example',
    },
    fetchImpl: async (url, init) => {
      const isJson = typeof init.body === 'string' && init.body.startsWith('{');
      requests.push({ url, body: isJson ? JSON.parse(init.body) : null });
      if (url.includes('login.microsoftonline')) {
        return { ok: true, status: 200, headers: new Map(), async json() { return { access_token: 'tok' }; } };
      }
      return { ok: true, status: 202, headers: { get: () => 'req-1' }, async json() { return {}; } };
    },
  });
  const result = await provider.deliver({
    rendered: { subject: 's', html: '<p>x</p>', text: 'x' },
    recipient: { email: 'pat@example.com' },
    attachments: [{ filename: 'appointment.ics', contentType: 'text/calendar; method=REQUEST', content: 'BEGIN:VCALENDAR' }],
  }, {});
  assert.equal(result.status, 'sent');
  const send = requests.find((r) => r.url.includes('sendMail'));
  const [attachment] = send.body.message.attachments;
  assert.equal(attachment['@odata.type'], '#microsoft.graph.fileAttachment');
  assert.equal(attachment.name, 'appointment.ics');
  assert.equal(Buffer.from(attachment.contentBytes, 'base64').toString('utf8'), 'BEGIN:VCALENDAR');
});
