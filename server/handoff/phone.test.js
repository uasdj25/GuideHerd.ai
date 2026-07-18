'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone } = require('./phone');

test('normalizePhone: E.164 input passes through canonically', () => {
  assert.equal(normalizePhone('+12565550100'), '+12565550100');
  assert.equal(normalizePhone('+442071234567'), '+442071234567');
  assert.equal(normalizePhone('  +12565550100  '), '+12565550100');
});

test('normalizePhone: human formatting is stripped', () => {
  assert.equal(normalizePhone('(256) 555-0100'), '+12565550100');
  assert.equal(normalizePhone('256.555.0100'), '+12565550100');
  assert.equal(normalizePhone('256 555 0100'), '+12565550100');
  assert.equal(normalizePhone('+1 (256) 555-0100'), '+12565550100');
});

test('normalizePhone: national-number conventions resolve with the default country code', () => {
  assert.equal(normalizePhone('2565550100'), '+12565550100', 'bare 10-digit national');
  assert.equal(normalizePhone('12565550100'), '+12565550100', '11 digits with country code');
  assert.equal(normalizePhone('0012565550100'), '+12565550100', '00 international prefix');
});

test('normalizePhone: never guesses — ambiguous or invalid input is null', () => {
  assert.equal(normalizePhone(''), null);
  assert.equal(normalizePhone('   '), null);
  assert.equal(normalizePhone('anonymous'), null);
  assert.equal(normalizePhone('555-0100'), null, 'too short to resolve without guessing');
  assert.equal(normalizePhone('2565550100x104'), null, 'extension marker');
  assert.equal(normalizePhone('++12565550100'), null, 'double prefix');
  assert.equal(normalizePhone('+0125655501'), null, 'no country code starts with 0');
  assert.equal(normalizePhone('+1234567890123456'), null, 'past the E.164 15-digit maximum');
  assert.equal(normalizePhone(null), null);
  assert.equal(normalizePhone(undefined), null);
  assert.equal(normalizePhone(12565550100), null, 'numbers are not phone strings');
});
