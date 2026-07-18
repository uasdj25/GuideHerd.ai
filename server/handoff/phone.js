'use strict';

/**
 * Phone number normalization (E.164) for prepared-session correlation.
 *
 * Correlation matches the number a receptionist typed against the number a
 * telephony provider reports, so both must reduce to one canonical form:
 * E.164 (`+` followed by up to 15 digits, no formatting).
 *
 * The normalizer is deliberately conservative: it strips common human
 * formatting (spaces, dots, dashes, parentheses) and resolves the
 * international-prefix conventions it can resolve UNAMBIGUOUSLY. Anything
 * else returns null — an unnormalizable number simply contributes no
 * correlation signal, which is always safer than guessing a wrong canonical
 * form and correlating two different callers.
 *
 * A bare national number (exactly 10 digits, no `+`/`00` prefix) is resolved
 * with the default country code. That default is NANP ('1') because every
 * current organization is North American; when organizations span dialing
 * plans, the default becomes per-organization configuration (Constitution
 * Principle 5) passed through the options argument — the call sites are
 * already parameterized for it.
 */

const DEFAULT_COUNTRY_CODE = '1';

/** E.164 bounds: country code + subscriber number, 15 digits maximum. */
const E164_MIN_DIGITS = 7;
const E164_MAX_DIGITS = 15;

/**
 * Normalize a phone number to E.164, or return null when the value cannot be
 * normalized without guessing.
 *
 * @param {unknown} raw the phone number as entered or as reported
 * @param {{ defaultCountryCode?: string }} [options]
 * @returns {string|null} `+<digits>` in E.164, or null
 */
function normalizePhone(raw, { defaultCountryCode = DEFAULT_COUNTRY_CODE } = {}) {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (value === '') return null;

  let international = false;
  if (value.startsWith('+')) {
    international = true;
    value = value.slice(1);
  }

  // Strip human formatting only. Any other character (letters, extension
  // markers like "x104", a second '+') makes the number ambiguous — null.
  value = value.replace(/[\s().-]/g, '');
  if (!/^\d+$/.test(value)) return null;

  // The 00 international-dialing prefix is equivalent to '+'.
  if (!international && value.startsWith('00')) {
    international = true;
    value = value.slice(2);
  }

  let digits;
  if (international) {
    digits = value;
  } else if (value.length === 10) {
    digits = defaultCountryCode + value; // bare national number
  } else if (value.length === 10 + defaultCountryCode.length && value.startsWith(defaultCountryCode)) {
    digits = value; // national number already carrying the country code
  } else {
    return null; // any other bare shape would be a guess
  }

  if (digits.length < E164_MIN_DIGITS || digits.length > E164_MAX_DIGITS) return null;
  if (digits.startsWith('0')) return null; // no country code begins with 0

  return '+' + digits;
}

module.exports = { normalizePhone, DEFAULT_COUNTRY_CODE };
