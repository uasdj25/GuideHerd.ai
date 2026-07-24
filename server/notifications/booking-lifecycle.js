'use strict';

/**
 * Booking lifecycle notifications (GitLab #88) — GuideHerd owns the
 * customer-facing communication for NATIVE bookings: confirmation on
 * booked, notice on cancelled, updated details on rescheduled. Rides
 * the Notification Contract (ADR-0011) unchanged: the delivery store's
 * claim machinery makes each logical notification exactly-once, and the
 * per-organization enablement (`notifications/appointment-confirmation`,
 * DEFAULT OFF) is honored — production behavior changes for no tenant
 * until a firm explicitly opts in.
 *
 * EXACTLY-ONCE across trigger paths: the notification key uses the
 * SESSION identity when one exists (`appointment-confirmation:<sessionId>`
 * — the same key the conversation-outcome trigger uses, so the two
 * paths dedupe against each other), else the booking-context id.
 *
 * verification_required NEVER produces a caller-facing message from
 * here — neither confirms nor denies (the deployed rule); its operator
 * escalation rides the #68 alerting engine at the call sites.
 */

const { readDomain } = require('../configuration/framework');

const LIFECYCLE_TYPES = Object.freeze({
  booked: 'appointment-confirmation',
  cancelled: 'appointment-cancellation',
  rescheduled: 'appointment-rescheduled',
});

/** Best-effort display names; absence never blocks a notification. */
function lifecycleDisplayNames(configService, organizationKey, { attorneyId, consultationTypeId }) {
  const names = {};
  try {
    if (attorneyId) {
      const attorney = configService.providers.get(organizationKey, attorneyId);
      if (attorney) names.attorneyName = attorney.displayName || attorney.name;
    }
  } catch { /* absent is fine */ }
  try {
    if (consultationTypeId) {
      const type = configService.consultationTypes.get(organizationKey, consultationTypeId);
      if (type) names.consultationType = type.name;
    }
  } catch { /* absent is fine */ }
  return names;
}

/**
 * Send one lifecycle notification for a native booking context.
 * @param {{ notifications: { send: Function }, configService: object,
 *   organizationKey: string, kind: 'booked'|'cancelled'|'rescheduled',
 *   bookingContext: object, recipient: { name?: string, email: string }|null,
 *   attributedAttorneyId?: string|null,
 *   correlationId?: string }} args
 * @returns {Promise<{ status: string }>} 'skipped_disabled' |
 *   'skipped_no_recipient' | the service result status
 */
async function sendBookingLifecycleNotification({
  notifications, configService, organizationKey, kind, bookingContext,
  recipient, attributedAttorneyId = null, correlationId,
}) {
  const type = LIFECYCLE_TYPES[kind];
  if (!type) throw new TypeError(`Unknown lifecycle kind: ${kind}`);
  // One enablement governs appointment lifecycle email (default OFF —
  // the double-notify guard until a firm confirms its calendar provider
  // attendee emails are quiet; for native Graph bookings that is the
  // graph-invitations toggle, default off, so enabling this is safe).
  const { value } = readDomain(configService, 'notifications', organizationKey);
  if (value.enabled !== true) return { status: 'skipped_disabled' };
  if (!recipient || !recipient.email) return { status: 'skipped_no_recipient' };

  const organization = configService.organizations.get(organizationKey);
  const identity = bookingContext.sessionId ?? bookingContext.bookingContextId;
  const names = lifecycleDisplayNames(configService, organizationKey, {
    attorneyId: attributedAttorneyId ?? bookingContext.attorneyId,
    consultationTypeId: bookingContext.consultationTypeId,
  });
  return notifications.send({
    type,
    organizationKey,
    notificationKey: `${type}:${identity}`,
    recipient: { email: recipient.email, ...(recipient.name ? { name: recipient.name } : {}) },
    appointment: {
      startsAt: bookingContext.selectedStartsAt,
      timezone: organization.timezone,
      durationMinutes: bookingContext.durationMinutes,
      ...(names.attorneyName ? { attorneyName: names.attorneyName } : {}),
      ...(names.consultationType ? { consultationType: names.consultationType } : {}),
    },
  }, { correlationId, sessionId: bookingContext.sessionId ?? undefined });
}

module.exports = { sendBookingLifecycleNotification, LIFECYCLE_TYPES };
