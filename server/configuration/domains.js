'use strict';

/**
 * Production configuration domains (ADR-0016).
 *
 * Each registration COMPOSES a validator that the owning subsystem
 * authors and exports — ownership stays with the consumer; this module
 * only assembles the registry. Every settings domain is LIVE: consumers
 * read per request, so an administered change affects the very next
 * request.
 *
 * Provider-selection domains share one shape ({ provider }) with
 * per-domain defaults; their strict write-time rule (the provider must
 * be registered on the deployment) runs only when the producer supplies
 * the registry context — consumers stay fail-safe.
 */

const { normalizePolicy } = require('../scheduling/policy');
const { normalizeBrandingDocument } = require('../notifications/branding');
const { normalizeSchedulingPromptProfile } = require('../connect/prompt-renderer');
const { normalizeCalcomAvailabilityConfig } = require('../scheduling/availability');
const {
  normalizeSchedulingTargetsConfig,
  validateSchedulingTargetsCrossEntity,
} = require('../scheduling/scheduling-targets');
const {
  normalizeBookingWindowConfig,
  validateBookingWindowCrossEntity,
} = require('../scheduling/slot-generation');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A `{ provider: string }` selection domain with a default key. */
function providerSelectionDomain({ id, title, owner, namespace, key, defaultProvider, registeredKeysContext }) {
  return {
    id,
    title,
    owner,
    namespace,
    key,
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { provider: defaultProvider }, issues: [] };
      if (!isPlainObject(raw)) {
        return { value: { provider: defaultProvider }, issues: ['must be an object like { "provider": "…" }'] };
      }
      const issues = [];
      for (const k of Object.keys(raw)) {
        if (k !== 'provider' && k !== 'agentId') issues.push(`unknown field: ${k}`);
      }
      const provider = typeof raw.provider === 'string' && raw.provider.trim() !== ''
        ? raw.provider.trim()
        : (issues.push('provider must be a nonblank string'), defaultProvider);
      const value = { provider };
      if (typeof raw.agentId === 'string' && raw.agentId.trim() !== '') value.agentId = raw.agentId.trim();
      return { value, issues };
    },
    validate(value, context) {
      const registered = context && context[registeredKeysContext];
      if (Array.isArray(registered) && !registered.includes(value.provider)) {
        return [`provider must be one of: ${registered.join(', ')}`];
      }
      return [];
    },
  };
}

/** Register every production settings domain on the given framework. */
function registerProductionDomains(framework) {
  // Scheduling policy — validator owned by the Scheduling Policy Engine.
  framework.register({
    id: 'scheduling-policy',
    title: 'Scheduling policy',
    owner: 'scheduling',
    namespace: 'scheduling',
    key: 'policy',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      const { policy, issues } = normalizePolicy(raw);
      return { value: policy, issues };
    },
  });

  // Default consultation type — what the assistant books when the caller
  // establishes none (real workflow behavior). Adopts the EXISTING seeded
  // setting address (scheduling/default-consultation-type): the value is
  // a consultation-type KEY; display wording is resolved from the catalog
  // entity by the consumer. There is deliberately NO default attorney —
  // when no attorney is established, the workflow asks the caller.
  framework.register({
    id: 'default-consultation-type',
    title: 'Default consultation type',
    owner: 'scheduling',
    namespace: 'scheduling',
    key: 'default-consultation-type',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: null, issues: [] };
      if (typeof raw !== 'string' || raw.trim() === '') {
        return { value: null, issues: ['must be a consultation type key (a nonblank string)'] };
      }
      return { value: raw.trim(), issues: [] };
    },
  });

  // Cal.com availability configuration — which Cal.com event type(s)
  // serve an organization's availability checks, and the appointment
  // length. Consumed by the server-side offered-slots service; the
  // Cal.com API KEY is environment configuration (CALCOM_API_KEY),
  // never a Configuration Store value. FAILS CLOSED: an organization
  // without a real configured event type cannot offer availability.
  framework.register({
    id: 'calcom-availability',
    title: 'Cal.com availability',
    owner: 'scheduling',
    namespace: 'scheduling',
    key: 'calcom-availability',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      return normalizeCalcomAvailabilityConfig(raw);
    },
    // STRICT write/import-time cross-entity rules (ADR-0007 §6 pattern):
    // every mapped key must reference a real, ACTIVE catalog entity, and
    // routing-group mappings must stay unambiguous for practice-area
    // resolution. Runs whenever the producer supplies configService +
    // organizationKey (administration writes and the seed-import gate);
    // consumers stay fail-safe — runtime resolution independently fails
    // closed on any unknown or unmapped key.
    validate(value, context) {
      const { configService, organizationKey } = context || {};
      if (!configService || !organizationKey) return [];
      const issues = [];
      const row = (catalog, key) => {
        try { return catalog.get(organizationKey, key); } catch { return null; }
      };
      for (const key of Object.keys(value.attorneyEventTypes)) {
        const attorney = row(configService.providers, key);
        if (!attorney) issues.push(`attorneyEventTypes.${key}: unknown attorney`);
        else if (attorney.active === false) issues.push(`attorneyEventTypes.${key}: attorney is not active`);
      }
      let groups = [];
      try { groups = configService.routingGroups.list(organizationKey); } catch { groups = []; }
      for (const key of Object.keys(value.routingGroupEventTypes)) {
        const group = groups.find((g) => g.key === key);
        if (!group) { issues.push(`routingGroupEventTypes.${key}: unknown routing group`); continue; }
        if (group.active === false) { issues.push(`routingGroupEventTypes.${key}: routing group is not active`); continue; }
        const sharing = groups.filter((g) => g.active !== false && g.serviceArea === group.serviceArea);
        if (sharing.length > 1) {
          issues.push(`routingGroupEventTypes.${key}: practice area "${group.serviceArea}" has ${sharing.length} active routing groups — resolution would be ambiguous`);
        }
      }
      return issues;
    },
  });

  // Calendar targets — the PROVIDER-NEUTRAL scheduling target domain
  // (GitLab #76): the tenant's native calendar provider selection and the
  // attorney/routing-group calendar bindings native scheduling routes
  // against. DARK BY DEFAULT (provider: null) — the deployed provider
  // path keeps serving production until the controlled cutover (#96)
  // selects otherwise per tenant. Cross-entity strictness and tenant
  // readiness are #77. The legacy `calcom-availability` domain above is
  // the TRANSITIONAL provider mapping, removed at decommission (#97).
  framework.register({
    id: 'calendar-targets',
    title: 'Calendar targets',
    owner: 'scheduling',
    namespace: 'scheduling',
    key: 'calendar-targets',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      return normalizeSchedulingTargetsConfig(raw);
    },
    // STRICT write/import-time cross-entity rules (#77): real active
    // attorneys and consultation types, unambiguous routing groups, a
    // registered provider when the registry context is supplied, and the
    // tenant-declarable full-coverage rule (every schedulable attorney
    // bound). Owned by the scheduling subsystem.
    validate(value, context) {
      return validateSchedulingTargetsCrossEntity(value, context);
    },
  });

  // Booking window — the tenant's native booking-shape policy (GitLab
  // #78): buffers, minimum notice, booking horizon, slot granularity,
  // holiday closures, and per-attorney weekly-hours overrides. HOURS
  // themselves stay in location officeHours (the three-hours model the
  // customer documentation teaches) — no default here can open a
  // calendar; absent hours mean NO native availability, fail closed.
  framework.register({
    id: 'booking-window',
    title: 'Booking window',
    owner: 'scheduling',
    namespace: 'scheduling',
    key: 'booking-window',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      return normalizeBookingWindowConfig(raw);
    },
    validate(value, context) {
      return validateBookingWindowCrossEntity(value, context);
    },
  });

  // Scheduling-assistant prompt profile — the tenant wording the rendered
  // ElevenLabs system prompt needs beyond the entity stores (timezone
  // display name, closing message). Validator owned by the prompt
  // renderer (connect); entity values (firm name, address, timezone)
  // come from the organization/location stores, never duplicated here.
  framework.register({
    id: 'scheduling-prompt',
    title: 'Scheduling-assistant prompt profile',
    owner: 'connect',
    namespace: 'connect',
    key: 'scheduling-prompt',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      return normalizeSchedulingPromptProfile(raw);
    },
  });

  // Notification branding — validator owned by the Notification Contract.
  framework.register({
    id: 'notification-branding',
    title: 'Notification branding',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'branding',
    live: true,
    schemaVersion: 1,
    normalize(raw, context) {
      return normalizeBrandingDocument(raw, context);
    },
  });

  // Notification enablement (appointment confirmations).
  framework.register({
    id: 'notifications',
    title: 'Notification enablement',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'appointment-confirmation',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { enabled: false }, issues: [] };
      const issues = [];
      if (!isPlainObject(raw)) {
        return { value: { enabled: false }, issues: ['must be an object like { "enabled": true }'] };
      }
      for (const k of Object.keys(raw)) {
        if (k !== 'enabled') issues.push(`unknown field: ${k}`);
      }
      if (typeof raw.enabled !== 'boolean') issues.push('enabled must be a boolean');
      return { value: { enabled: raw.enabled === true }, issues };
    },
  });

  // Graph attendee invitations (GitLab #88 decision of record):
  // GuideHerd-owned email (with ICS) is the DEFAULT customer
  // communication channel; whether the calendar provider ALSO sends its
  // own attendee invitations is tenant policy — DEFAULT OFF, so native
  // bookings never double-notify a caller. When off, the attendee is not
  // attached to the provider event at all.
  framework.register({
    id: 'graph-invitations',
    title: 'Calendar provider attendee invitations',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'graph-invitations',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { enabled: false }, issues: [] };
      const issues = [];
      if (!isPlainObject(raw)) {
        return { value: { enabled: false }, issues: ['must be an object like { "enabled": true }'] };
      }
      for (const k of Object.keys(raw)) {
        if (k !== 'enabled') issues.push(`unknown field: ${k}`);
      }
      if (typeof raw.enabled !== 'boolean') issues.push('enabled must be a boolean');
      return { value: { enabled: raw.enabled === true }, issues };
    },
  });

  // Data retention (ADR-0006 / #63) — how long operational sessions live
  // before hard deletion. DEFAULTS are ADR-0006's PROPOSED windows
  // (sign-off pending); every field is organization-overridable. Bounded
  // to sane ranges; a malformed field degrades to the default and is
  // reported (fail-safe read, strict write).
  framework.register({
    id: 'data-retention',
    title: 'Data retention',
    owner: 'operational-store',
    namespace: 'retention',
    key: 'policy',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      // DARK BY DEFAULT (#63 safety correction): retention is DESTRUCTIVE,
      // so an unconfigured organization is never purged. `enabled` must be
      // set to `true` explicitly to activate the sweep. The 24h/30d numbers
      // are ADR-0006's SUGGESTED windows — used only when enabled, never a
      // reason to delete on their own.
      const SUGGESTED = { cancelledExpiredHours: 24, terminalDays: 30 };
      const dark = { enabled: false, ...SUGGESTED };
      if (raw === null || raw === undefined) return { value: dark, issues: [] };
      const issues = [];
      if (!isPlainObject(raw)) {
        return { value: dark, issues: ['must be an object like { "enabled": true, "cancelledExpiredHours": 24, "terminalDays": 30 }'] };
      }
      for (const k of Object.keys(raw)) {
        if (!['enabled', 'cancelledExpiredHours', 'terminalDays'].includes(k)) issues.push(`unknown field: ${k}`);
      }
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') issues.push('enabled must be a boolean');
      const intField = (name, def, min, max) => {
        if (raw[name] === undefined) return def;
        const v = raw[name];
        if (!Number.isInteger(v) || v < min || v > max) {
          issues.push(`${name} must be an integer between ${min} and ${max}`);
          return def;
        }
        return v;
      };
      const value = {
        // Enabled only on an explicit, valid true — never inferred.
        enabled: raw.enabled === true && issues.length === 0,
        cancelledExpiredHours: intField('cancelledExpiredHours', SUGGESTED.cancelledExpiredHours, 1, 24 * 365),
        terminalDays: intField('terminalDays', SUGGESTED.terminalDays, 1, 3650),
      };
      return { value, issues };
    },
  });

  // Failure alerting (#68) — who hears about operational failures.
  // DEFAULT OFF: nothing emails anyone until a firm names a recipient and
  // enables it. The recipient is the firm's administrator mailbox —
  // customer configuration, never a secret.
  framework.register({
    id: 'operational-alerts',
    title: 'Operational alerts',
    owner: 'operations',
    namespace: 'operations',
    key: 'alerts',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      const dark = { enabled: false, recipient: null };
      if (raw === null || raw === undefined) return { value: dark, issues: [] };
      const issues = [];
      if (!isPlainObject(raw)) {
        return { value: dark, issues: ['must be an object like { "enabled": true, "recipient": "ops@firm.example" }'] };
      }
      for (const k of Object.keys(raw)) {
        if (!['enabled', 'recipient'].includes(k)) issues.push(`unknown field: ${k}`);
      }
      if (typeof raw.enabled !== 'boolean') issues.push('enabled must be a boolean');
      let recipient = null;
      if (raw.recipient !== null && raw.recipient !== undefined) {
        if (typeof raw.recipient !== 'string' || raw.recipient.length > 254
          || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.recipient.trim())) {
          issues.push('recipient must be an email address');
        } else {
          recipient = raw.recipient.trim();
        }
      }
      if (raw.enabled === true && !recipient) issues.push('enabling alerts requires a recipient');
      const enabled = raw.enabled === true && recipient !== null && issues.length === 0;
      return { value: { enabled, recipient }, issues };
    },
  });

  // Appointment reminder scheduling — validator owned by the Scheduler
  // (ADR-0018). DISABLED BY DEFAULT: today's production behavior is
  // preserved until a firm explicitly enables reminders. The offsets
  // list naturally admits additional intervals later (one more entry).
  framework.register({
    id: 'appointment-reminders',
    title: 'Appointment reminders',
    owner: 'scheduler',
    namespace: 'scheduler',
    key: 'appointment-reminders',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      const DEFAULT_OFFSETS = [
        { slot: '24h', minutesBefore: 24 * 60 },
        { slot: '1h', minutesBefore: 60 },
      ];
      const defaults = { enabled: false, offsets: DEFAULT_OFFSETS };
      if (raw === null || raw === undefined) return { value: defaults, issues: [] };
      if (!isPlainObject(raw)) {
        return { value: defaults, issues: ['must be an object like { "enabled": true, "offsets": [...] }'] };
      }
      const issues = [];
      for (const k of Object.keys(raw)) {
        if (!['enabled', 'offsets'].includes(k)) issues.push(`unknown field: ${k}`);
      }
      if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') issues.push('enabled must be a boolean');

      let offsets = DEFAULT_OFFSETS;
      if (raw.offsets !== undefined) {
        if (!Array.isArray(raw.offsets) || raw.offsets.length === 0) {
          issues.push('offsets must be a non-empty array of { slot, minutesBefore }');
        } else {
          const seen = new Set();
          const cleaned = [];
          for (const entry of raw.offsets) {
            const slot = isPlainObject(entry) && typeof entry.slot === 'string' ? entry.slot.trim() : '';
            const minutes = isPlainObject(entry) ? entry.minutesBefore : undefined;
            if (slot === '' || !/^[a-z0-9-]{1,32}$/.test(slot)) {
              issues.push('every offset needs a short lowercase slot (e.g. "24h")');
              continue;
            }
            if (seen.has(slot)) {
              issues.push(`duplicate offset slot: ${slot}`);
              continue;
            }
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 40320) {
              issues.push(`offset "${slot}": minutesBefore must be an integer between 1 and 40320 (4 weeks)`);
              continue;
            }
            seen.add(slot);
            cleaned.push({ slot, minutesBefore: minutes });
          }
          if (cleaned.length > 0) offsets = cleaned.sort((a, b) => b.minutesBefore - a.minutesBefore);
          else issues.push('no usable offsets; defaults apply');
        }
      }
      return { value: { enabled: raw.enabled === true, offsets }, issues };
    },
  });

  framework.register(providerSelectionDomain({
    id: 'identity-provider',
    title: 'Identity provider selection',
    owner: 'identity',
    namespace: 'identity',
    key: 'provider',
    defaultProvider: 'static-token',
    registeredKeysContext: 'identityProviderKeys',
  }));

  framework.register(providerSelectionDomain({
    id: 'conversation-provider',
    title: 'Conversation provider selection',
    owner: 'connect',
    namespace: 'connect',
    key: 'conversation-provider',
    defaultProvider: 'elevenlabs',
    registeredKeysContext: 'conversationProviderKeys',
  }));

  framework.register(providerSelectionDomain({
    id: 'notification-provider',
    title: 'Notification provider selection',
    owner: 'notifications',
    namespace: 'notifications',
    key: 'provider',
    defaultProvider: 'graph-email',
    registeredKeysContext: 'notificationProviderKeys',
  }));

  // Integration provider selection (ADR-0020) — PER CAPABILITY. The value
  // maps each integration TYPE to the provider that serves it, so a firm
  // can route practice-management records, calendars, and billing to
  // DIFFERENT systems at once, and one provider may serve several types.
  // DARK BY DEFAULT: the default map is empty, and an unmapped type is the
  // controlled 'not-configured' result — never an error. Writes stay
  // strict when the producer supplies context (ADR-0007 §6): every mapped
  // type must be a registered integration capability, and every mapped
  // provider must be registered on the deployment.
  framework.register({
    id: 'integration-providers',
    title: 'Integration provider selection',
    owner: 'integrations',
    namespace: 'integrations',
    key: 'providers',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { providers: {} }, issues: [] };
      if (!isPlainObject(raw)) {
        return { value: { providers: {} }, issues: ['must be an object like { "providers": { "<type>": "<provider>" } }'] };
      }
      const issues = [];
      for (const k of Object.keys(raw)) {
        if (k !== 'providers') issues.push(`unknown field: ${k}`);
      }
      const providers = {};
      if (raw.providers !== undefined) {
        if (!isPlainObject(raw.providers)) {
          issues.push('providers must map integration types to provider keys');
        } else {
          for (const [type, provider] of Object.entries(raw.providers)) {
            if (typeof type !== 'string' || type.trim() === '') {
              issues.push('integration type keys must be nonblank strings');
              continue;
            }
            if (typeof provider !== 'string' || provider.trim() === '') {
              issues.push(`provider for ${type} must be a nonblank string`);
              continue;
            }
            providers[type.trim()] = provider.trim();
          }
        }
      }
      return { value: { providers }, issues };
    },
    validate(value, context) {
      const issues = [];
      const types = context && context.integrationTypes;
      const registered = context && context.integrationProviderKeys;
      for (const [type, provider] of Object.entries(value.providers)) {
        if (Array.isArray(types) && !types.includes(type)) {
          issues.push(`unknown integration type: ${type} (known: ${types.join(', ')})`);
        }
        if (Array.isArray(registered) && !registered.includes(provider)) {
          issues.push(`provider for ${type} must be one of: ${registered.join(', ')}`);
        }
      }
      return issues;
    },
  });

  // Workflow enablement (ADR-0021). DARK BY DEFAULT: no workflow type runs
  // for an organization until it is listed here. Reads are fail-safe
  // (damage degrades to the empty list); writes are strict — a listed type
  // must be a registered workflow definition when the producer supplies
  // the registry context (ADR-0007 §6).
  framework.register({
    id: 'workflows',
    title: 'Workflow enablement',
    owner: 'workflow',
    namespace: 'workflow',
    key: 'enabled-types',
    live: true,
    schemaVersion: 1,
    normalize(raw) {
      if (raw === null || raw === undefined) return { value: { enabledTypes: [] }, issues: [] };
      if (!isPlainObject(raw)) {
        return { value: { enabledTypes: [] }, issues: ['must be an object like { "enabledTypes": ["…"] }'] };
      }
      const issues = [];
      for (const k of Object.keys(raw)) {
        if (k !== 'enabledTypes') issues.push(`unknown field: ${k}`);
      }
      const enabledTypes = [];
      if (raw.enabledTypes !== undefined) {
        if (!Array.isArray(raw.enabledTypes)) {
          issues.push('enabledTypes must be an array of workflow type keys');
        } else {
          for (const t of raw.enabledTypes) {
            if (typeof t === 'string' && t.trim() !== '') {
              if (!enabledTypes.includes(t.trim())) enabledTypes.push(t.trim());
            } else {
              issues.push('enabledTypes entries must be nonblank strings');
            }
          }
        }
      }
      return { value: { enabledTypes }, issues };
    },
    validate(value, context) {
      const registered = context && context.workflowTypes;
      if (Array.isArray(registered)) {
        const unknown = value.enabledTypes.filter((t) => !registered.includes(t));
        if (unknown.length) return [`unknown workflow types: ${unknown.join(', ')} (registered: ${registered.join(', ') || 'none'})`];
      }
      return [];
    },
  });
}

/**
 * The store-backed ENTITY domains (documentation of the complete model;
 * their schema/validation live in the Configuration Store's normalizers
 * per ADR-0004, administered via ADR-0015 entity areas — all LIVE).
 */
const ENTITY_DOMAINS = Object.freeze([
  { id: 'organization', owner: 'configuration-store', live: true },
  { id: 'practice-areas', owner: 'configuration-store', live: true },
  { id: 'attorneys', owner: 'configuration-store', live: true },
  { id: 'consultation-types', owner: 'configuration-store', live: true },
  { id: 'routing-groups', owner: 'configuration-store', live: true },
  { id: 'locations-and-hours', owner: 'configuration-store', live: true },
]);

module.exports = { registerProductionDomains, ENTITY_DOMAINS };
