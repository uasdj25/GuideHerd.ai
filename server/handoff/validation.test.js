'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCreate, normalizeRedeem } = require('./validation');

function base() {
  return {
    firmId: 'martinson-beason',
    caller: { fullName: 'David Jones', phone: '+14044232676' },
    scheduling: { attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  };
}

function fieldErrors(body) {
  try {
    normalizeCreate(body);
    return null;
  } catch (e) {
    return e.details.map((d) => d.field);
  }
}

test('a fully valid request normalizes and trims', () => {
  const out = normalizeCreate({ ...base(), firmId: '  martinson-beason  ' });
  assert.equal(out.firmId, 'martinson-beason');
  assert.equal(out.scheduling.existingClient, false); // defaulted
});

test('missing firmId is rejected', () => {
  const body = base();
  delete body.firmId;
  assert.ok(fieldErrors(body).includes('firmId'));
});

test('missing caller name is rejected', () => {
  const body = base();
  delete body.caller.fullName;
  assert.ok(fieldErrors(body).includes('caller.fullName'));
});

test('missing attorney ID is rejected', () => {
  const body = base();
  delete body.scheduling.attorneyId;
  assert.ok(fieldErrors(body).includes('scheduling.attorneyId'));
});

test('missing consultation type is rejected', () => {
  const body = base();
  delete body.scheduling.consultationTypeId;
  assert.ok(fieldErrors(body).includes('scheduling.consultationTypeId'));
});

test('blank handoff source is rejected', () => {
  const body = base();
  body.handoff.source = '   ';
  assert.ok(fieldErrors(body).includes('handoff.source'));
});

test('blank handoff mode is rejected', () => {
  const body = base();
  body.handoff.mode = '';
  assert.ok(fieldErrors(body).includes('handoff.mode'));
});

test('oversized string is rejected', () => {
  const body = base();
  body.firmId = 'x'.repeat(1000);
  assert.ok(fieldErrors(body).includes('firmId'));
});

test('wrong type for existingClient is rejected', () => {
  const body = base();
  body.scheduling.existingClient = 'nope';
  assert.ok(fieldErrors(body).includes('scheduling.existingClient'));
});

test('optional fields may be omitted', () => {
  const out = normalizeCreate({
    firmId: 'martinson-beason',
    caller: { fullName: 'David Jones' },
    scheduling: { attorneyId: 'clay-martinson', consultationTypeId: 'initial-consultation' },
    handoff: { source: 'receptionist-portal', mode: 'live-transfer' },
  });
  assert.equal('phone' in out.caller, false);
  assert.equal('practiceAreaId' in out.scheduling, false);
  assert.equal('createdByUserId' in out.handoff, false);
});

test('redeem requires a non-blank token', () => {
  assert.throws(() => normalizeRedeem({}), (e) => e.status === 400);
  assert.throws(() => normalizeRedeem({ handoffToken: '   ' }), (e) => e.status === 400);
  assert.throws(() => normalizeRedeem({ handoffToken: 42 }), (e) => e.status === 400);
  assert.deepEqual(normalizeRedeem({ handoffToken: ' gh_handoff_abc ' }), { handoffToken: 'gh_handoff_abc' });
});
