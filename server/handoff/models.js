'use strict';

/**
 * Domain models and limits for the Context Handoff API.
 *
 * These typedefs document the GuideHerd contract. They use GuideHerd domain
 * language only — no vendor concepts appear anywhere in these shapes.
 *
 * @typedef {Object} Caller
 * @property {string} fullName
 * @property {string} email
 * @property {string} [phone]
 *
 * @typedef {Object} Scheduling
 * @property {string} [attorneyId]   optional: the caller may have no preference
 * @property {string} [practiceAreaId]
 * @property {string} consultationTypeId
 * @property {boolean} [existingClient]
 *
 * @typedef {Object} HandoffMeta
 * @property {string} [createdByUserId]
 * @property {string} source
 * @property {string} mode
 *
 * @typedef {Object} CreateHandoffRequest
 * @property {string} firmId
 * @property {Caller} caller
 * @property {Scheduling} scheduling
 * @property {HandoffMeta} handoff
 *
 * Internal record. Hash and `*Ms` fields never leave the service. Raw tokens
 * are never stored — only their SHA-256 hashes.
 * @typedef {Object} InternalSession
 * @property {string} sessionId
 * @property {string} firmId
 * @property {Caller} caller
 * @property {Scheduling} scheduling
 * @property {HandoffMeta} handoff
 * @property {string} status
 * @property {string} tokenHash          hash of the handoff (voice-side) token
 * @property {string} consoleTokenHash   hash of the console (receptionist) token
 * @property {number|null} redeemedAtMs
 * @property {number|null} cancelledAtMs
 * @property {number} createdAtMs
 * @property {number} expiresAtMs
 *
 * @typedef {Object} CreateHandoffResponse
 * @property {string} sessionId
 * @property {string} handoffToken   voice-side credential (redeem only)
 * @property {string} consoleToken   receptionist credential (status/cancel only)
 * @property {string} status
 * @property {string} createdAt   ISO-8601 UTC
 * @property {string} expiresAt   ISO-8601 UTC
 * @property {number} expiresInSeconds
 *
 * Operational status metadata for the console. Never includes caller context.
 * @typedef {Object} SessionStatusResponse
 * @property {string} sessionId
 * @property {string} status
 * @property {string} createdAt
 * @property {string} expiresAt
 *
 * Minimum conversational context returned to the Scheduling Assistant.
 * @typedef {Object} RedeemResponse
 * @property {string} sessionId
 * @property {string} callerName
 * @property {string} callerLastName
 * @property {string} callerEmail
 * @property {string|null} callerPhone
 * @property {string|null} attorneyId
 * @property {string|null} practiceAreaId
 * @property {string} consultationTypeId
 * @property {boolean} existingClient
 * @property {string} status
 */

/** Lifetime of a handoff/session, in seconds (10 minutes). */
const HANDOFF_TTL_SECONDS = 600;

/**
 * Maximum accepted length per string field. These guard against accidental
 * oversized payloads; they are not business rules.
 */
const LIMITS = Object.freeze({
  firmId: 128,
  fullName: 200,
  email: 254,
  phone: 40,
  attorneyId: 128,
  practiceAreaId: 128,
  consultationTypeId: 128,
  createdByUserId: 128,
  source: 64,
  mode: 64,
  token: 512,
});

module.exports = { HANDOFF_TTL_SECONDS, LIMITS };
