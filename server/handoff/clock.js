'use strict';

/**
 * Time provider abstraction.
 *
 * All time in this service is epoch milliseconds in UTC. Injecting a clock lets
 * expiration behaviour be tested deterministically, with no sleeps.
 *
 * @typedef {Object} Clock
 * @property {() => number} now  Current time as epoch milliseconds (UTC).
 */

/** @returns {Clock} A clock backed by the system time. */
function systemClock() {
  return { now: () => Date.now() };
}

/**
 * A controllable clock for tests.
 * @param {number} startMs Initial time as epoch milliseconds.
 */
function fixedClock(startMs) {
  let current = startMs;
  return {
    now: () => current,
    /** Advance the clock by a number of milliseconds. */
    advance: (ms) => { current += ms; },
    /** Set the clock to an absolute epoch-millisecond value. */
    set: (ms) => { current = ms; },
  };
}

module.exports = { systemClock, fixedClock };
