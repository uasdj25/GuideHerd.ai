'use strict';

/**
 * GuideHerd Authorization (ADR-0010) — the permanent authorization boundary.
 *
 * Authentication (ADR-0009) answers "who is this?" and produces a
 * GuideHerdIdentity. THIS module answers "what may this principal do, for
 * which organization and resource?" — and it is the only place that
 * answers it. Routes and business services express intent in GuideHerd
 * permission vocabulary; they never compare role strings, never inspect
 * provider claims, and never implement organization checks ad hoc.
 *
 * ── Principals ─────────────────────────────────────────────────────────────
 *
 * authorize() evaluates exactly one of three principal kinds:
 *
 *   { identity }     an authenticated GuideHerdIdentity (ADR-0009)
 *   { capability }   a session capability credential fact:
 *                    { type: 'handoff-token'|'console-token', sessionId }
 *                    — asserted by the repository AFTER it has verified the
 *                    credential (constant-time hash comparison); this layer
 *                    enforces WHICH operations that capability may perform
 *                    and on WHICH resource
 *   { anonymous }    no credential — permitted ONLY what the policy's
 *                    anonymous grants explicitly name (the deliberately
 *                    public Reception Console surface); everything else
 *                    fails closed
 *
 * ── Policy ─────────────────────────────────────────────────────────────────
 *
 * The policy is GuideHerd-owned code, not provider data and not
 * configuration: identity providers assert GuideHerd ROLE names, and only
 * this policy decides what a role permits (an IdP claim can therefore never
 * directly become a business authorization decision). Each role maps to:
 *
 *   { scope: 'organization' | 'platform', permissions: [...] }
 *
 * Organization-scoped roles act only inside the identity's own
 * organization: the identity's organizationKey must equal the context's.
 * An identity WITHOUT an organizationKey holding an organization-scoped
 * role is DENIED organization-scoped operations — absent scope never means
 * global reach. Platform scope exists only where a role mapping declares
 * `scope: 'platform'` explicitly; no production role does today.
 *
 * Every unknown — permission, role, capability type, principal shape —
 * fails closed with the same generic 403. Denials are structurally
 * indistinguishable (missing permission vs. wrong tenant vs. wrong
 * resource), so an authorization failure never reveals whether another
 * organization's resource exists.
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 *
 * Every denial emits one structured audit event; successes are audited
 * only where the route opts in (low-frequency privileged operations —
 * never per-poll console traffic). Audit events carry identifiers and
 * decision facts ONLY: no bearer or capability tokens, no provider claims,
 * no caller names/emails/phones, no request payloads.
 */

const { PermissionDeniedError } = require('./errors');

/** The complete permission vocabulary — the platform's current workflows. */
const PERMISSIONS = Object.freeze([
  'handoff:create',
  'handoff:read',
  'handoff:cancel',
  'handoff:redeem',
  'conversation:connect',
  'conversation:complete',
  'summary:read',
  'configuration:read',
  'operations:read',
]);

/**
 * Role → scope + permissions. Roles are convenient bundles; permissions are
 * the decisions. The production policy is deliberately minimal: exactly the
 * roles current workflows require. Future personas (receptionist logins,
 * firm administrators, GuideHerd operators) are added HERE when a workflow
 * needs them — with `scope: 'platform'` reserved for explicitly designated
 * operator identities.
 */
const DEFAULT_POLICY = Object.freeze({
  roles: Object.freeze({
    // The Guide-side service identity used by the scheduling workflow
    // (today: the assistant runtime reaching the demo bridge). Scoped to
    // its organization; holds only what that workflow performs.
    'scheduling-assistant': Object.freeze({
      scope: 'organization',
      permissions: Object.freeze(['conversation:connect', 'conversation:complete', 'summary:read']),
    }),

    // Reception Console users (ADR-0013): authenticated receptionists hold
    // exactly the console's two operations, scoped to their organization.
    // Session status/cancel remain capability-token operations (ADR-0010).
    receptionist: Object.freeze({
      scope: 'organization',
      permissions: Object.freeze(['handoff:create', 'configuration:read']),
    }),

    // Operations Center users (ADR-0014): read-only operational
    // visibility into their own organization. Org-scoped; a future
    // platform-operator persona would be a separate, explicitly
    // platform-scoped role.
    operator: Object.freeze({
      scope: 'organization',
      permissions: Object.freeze(['operations:read']),
    }),
  }),

  /**
   * The deliberately PUBLIC surface — the Reception Console has no user
   * login yet (ADR-0010 records the deferral), so these two operations are
   * intentionally anonymous, declared centrally so no route is ever
   * accidentally anonymous:
   *   handoff:create      prepare a caller (rate-contained by the per-
   *                       organization prepared-session cap)
   *   configuration:read  the scheduling options the console renders
   */
  anonymous: Object.freeze(['handoff:create', 'configuration:read']),
});

/**
 * What each session capability credential may do — and nothing else. The
 * credential itself is verified by the repository (constant-time hash,
 * single-use/expiry state machine); this mapping pins the operations.
 */
const CAPABILITY_GRANTS = Object.freeze({
  'handoff-token': Object.freeze(['handoff:redeem']),
  'console-token': Object.freeze(['handoff:read', 'handoff:cancel']),
});

/**
 * @param {{
 *   policy?: typeof DEFAULT_POLICY,
 *   capabilityGrants?: typeof CAPABILITY_GRANTS,
 *   log?: (line: string) => void,
 * }} [options] injectable for tests; production uses the defaults
 */
function createAuthorization({ policy = DEFAULT_POLICY, capabilityGrants = CAPABILITY_GRANTS, log = console.log } = {}) {
  /** Emit one structured, PII-free audit event. */
  function audit(result, principalFacts, permission, context) {
    log(JSON.stringify({
      level: 'audit',
      event: `authorization.${result}`,
      ...principalFacts,
      permission,
      organizationKey: (context && context.organizationKey) || null,
      resourceType: (context && context.resource && context.resource.type) || null,
      sessionId: (context && context.resource && context.resource.id) || null,
    }));
  }

  /** Safe, identifier-only facts about a principal for audit events. */
  function principalFactsOf(principal) {
    if (principal && principal.identity) {
      return {
        principal: 'identity',
        subject: principal.identity.subject ?? null,
        identityType: principal.identity.type ?? null,
        identityOrganizationKey: principal.identity.organizationKey ?? null,
      };
    }
    if (principal && principal.capability) {
      return { principal: 'capability', capabilityType: principal.capability.type ?? null };
    }
    if (principal && principal.anonymous === true) {
      return { principal: 'anonymous' };
    }
    return { principal: 'unknown' };
  }

  /** The core decision. Returns true to allow; any other path is a denial. */
  function decide(principal, permission, context) {
    if (!PERMISSIONS.includes(permission)) return false; // unknown intent fails closed

    // ── Anonymous: only the policy's explicit public grants ──────────────
    if (principal && principal.anonymous === true) {
      return policy.anonymous.includes(permission);
    }

    // ── Capability: exact operation on exactly its own session ───────────
    if (principal && principal.capability) {
      const { type, sessionId } = principal.capability;
      const grants = capabilityGrants[type];
      if (!grants || !grants.includes(permission)) return false;
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const resource = context && context.resource;
      if (!resource || resource.type !== 'handoff-session' || resource.id !== sessionId) return false;
      return true;
    }

    // ── Identity: role permissions + organization/platform scope ─────────
    if (principal && principal.identity) {
      const identity = principal.identity;
      if (!Array.isArray(identity.roles)) return false;
      for (const roleName of identity.roles) {
        const role = policy.roles[roleName];
        if (!role || !role.permissions.includes(permission)) continue;
        if (role.scope === 'platform') return true; // explicitly designated
        if (role.scope !== 'organization') continue; // unknown scopes fail closed
        // Organization-scoped: the identity must be scoped to the SAME
        // organization the operation targets. No organizationKey on either
        // side is a denial — absence never widens access.
        if (typeof identity.organizationKey === 'string' && identity.organizationKey !== ''
          && context && context.organizationKey === identity.organizationKey) {
          return true;
        }
      }
      return false;
    }

    return false; // no recognizable principal
  }

  return {
    /**
     * Authorize or throw. The ONLY authorization decision point.
     *
     * @param {{ identity?: object, capability?: {type: string, sessionId: string}, anonymous?: true }} principal
     * @param {string} permission one of PERMISSIONS
     * @param {{ organizationKey?: string, resource?: { type: string, id: string }, auditSuccess?: boolean }} [context]
     * @returns {true}
     * @throws {PermissionDeniedError} on any denial — always the same
     *         generic 403; the denial reason goes to the audit log only.
     */
    authorize(principal, permission, context = {}) {
      const allowed = decide(principal, permission, context);
      if (!allowed) {
        audit('denied', principalFactsOf(principal), permission, context);
        throw new PermissionDeniedError();
      }
      // Success audit is opt-in per call site: privileged, low-frequency
      // operations only — never high-frequency console polling.
      if (context.auditSuccess === true) {
        audit('allowed', principalFactsOf(principal), permission, context);
      }
      return true;
    },
  };
}

module.exports = {
  createAuthorization,
  PERMISSIONS,
  DEFAULT_POLICY,
  CAPABILITY_GRANTS,
};
