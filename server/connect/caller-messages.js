'use strict';

/**
 * Calm, generic caller-facing messages for Connect-facing (assistant)
 * responses (Issue #8).
 *
 * When a demo-bridge/Connect request fails, the error envelope gains a
 * `callerMessage`: stable, provider-free text the Guide can deliver to the
 * caller (or use to decide escalation). Never provider names, HTTP
 * details, exception text, or implementation details — and never the
 * correlation ID (the Guide must not read identifiers aloud; the
 * correlation ID travels separately in the envelope and header for
 * support use).
 *
 * Keyed by GuideHerd error category. The existing machine-readable
 * `error.code` remains the Guide's primary branching signal; this text is
 * the human fallback.
 */

const CALLER_MESSAGES = Object.freeze({
  validation_error: 'Something about that request didn’t look right. Please try again, or the office can follow up directly.',
  not_found: 'I don’t have a prepared caller for that right now. The front desk can prepare the transfer and try again.',
  conflict: 'That request could not be completed as things stand right now. The front desk can confirm the current status.',
  rate_limited: 'The office line is quite busy at the moment. Please try again shortly.',
  provider_unavailable: 'We’re having trouble checking the calendar right now. Please try again in a moment.',
  provider_timeout: 'We’re having trouble checking the calendar right now. Please try again in a moment.',
  booking_failed: 'I’m sorry, I couldn’t complete the appointment just now. The office can follow up with you directly.',
  unexpected_error: 'Something went wrong while completing that request. Please try again or contact the office.',
});

/**
 * The caller-facing message for an error category (never undefined —
 * unknown categories get the calm unexpected-error message).
 * @param {string} category
 */
function callerMessageFor(category) {
  return CALLER_MESSAGES[category] || CALLER_MESSAGES.unexpected_error;
}

module.exports = { CALLER_MESSAGES, callerMessageFor };
