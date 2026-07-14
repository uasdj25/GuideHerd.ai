'use strict';

/**
 * Session lifecycle statuses.
 *
 * The full set is defined here so the public contract is stable as new
 * transitions are added later. This ticket only implements:
 *   creation            -> awaiting-transfer
 *   successful redeem   -> connected
 *   expiration          -> expired
 */
const SessionStatus = Object.freeze({
  AWAITING_TRANSFER: 'awaiting-transfer',
  CONNECTED: 'connected',
  SCHEDULING: 'scheduling',
  BOOKED: 'booked',
  FAILED: 'failed',
  ESCALATED: 'escalated',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

const ALL_STATUSES = Object.freeze(Object.values(SessionStatus));

module.exports = { SessionStatus, ALL_STATUSES };
