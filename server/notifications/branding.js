'use strict';

/**
 * Notification branding (ADR-0011) — GuideHerd owns how customer
 * notifications look and who they appear to come from.
 *
 * Notifications present as communications FROM THE LAW FIRM, delivered by
 * GuideHerd. No provider branding (no calendar-provider or mail-provider
 * names), no implementation details, ever.
 *
 * Branding resolves per organization: sensible defaults derive from the
 * Configuration Store organization record, and firms may override fields
 * through the `notifications/branding` setting (ADR-0004 namespaced-
 * setting pattern). This module establishes the ARCHITECTURE for future
 * customization (sender name, logo, colors, footer, office information);
 * a branding administration surface is deliberately not built here.
 *
 * Branding model:
 *   {
 *     senderName,          how the firm is named in the message
 *     accentColor,         template accent (hex)
 *     logoUrl,             optional firm logo (absolute https URL)
 *     footerText,          closing footer line
 *     office: { phone, email, address }   optional contact block
 *   }
 */

const SETTINGS_NAMESPACE = 'notifications';
const BRANDING_KEY = 'branding';

const DEFAULT_ACCENT = '#1f3a5f';

function nonblank(v, max = 300) {
  return typeof v === 'string' && v.trim() !== '' && v.length <= max ? v.trim() : null;
}

/**
 * The branding domain's normalizer (ADR-0016): the SINGLE place branding
 * documents are validated, defaulted, and normalized — registered with
 * the Customer Configuration Framework and owned here by the
 * Notification subsystem. Lenient: every malformed field degrades to its
 * default AND is reported as an issue (producers require zero issues;
 * consumers use the value regardless).
 *
 * @param {unknown} raw the stored branding document (or null)
 * @param {{ configService?: object|null, organizationKey?: string }} [context]
 * @returns {{ value: object, issues: string[] }}
 */
function normalizeBrandingDocument(raw, { configService = null, organizationKey } = {}) {
  const issues = [];
  let organizationName = null;
  if (configService && organizationKey) {
    try {
      const org = configService.organizations.get(organizationKey);
      organizationName = nonblank(org && org.name, 200);
    } catch { /* unknown organization — defaults apply */ }
  }
  let overrides = {};
  if (raw !== null && raw !== undefined) {
    if (typeof raw === 'object' && !Array.isArray(raw)) overrides = raw;
    else issues.push('branding must be an object');
  }
  for (const key of Object.keys(overrides)) {
    if (!['senderName', 'accentColor', 'logoUrl', 'footerText', 'office'].includes(key)) {
      issues.push(`unknown field: ${key}`);
    }
  }
  const check = (field, ok) => { if (overrides[field] !== undefined && !ok) issues.push(`${field} is invalid`); };
  const senderOverride = nonblank(overrides.senderName, 200);
  check('senderName', senderOverride !== null);
  const accentOverride = nonblank(overrides.accentColor, 16);
  const accentValid = accentOverride !== null && /^#[0-9a-fA-F]{3,8}$/.test(accentOverride);
  check('accentColor', accentValid);
  const logoCandidate = nonblank(overrides.logoUrl, 500);
  const logoValid = logoCandidate !== null && logoCandidate.startsWith('https://');
  check('logoUrl', logoValid);
  const footerOverride = nonblank(overrides.footerText, 500);
  check('footerText', footerOverride !== null);
  const office = overrides.office && typeof overrides.office === 'object' && !Array.isArray(overrides.office)
    ? overrides.office : {};
  if (overrides.office !== undefined && office !== overrides.office) issues.push('office must be an object');
  for (const key of Object.keys(office)) {
    if (!['phone', 'email', 'address'].includes(key)) issues.push(`office.${key} is not an office field`);
  }

  const senderName = senderOverride || organizationName || 'Your law office';
  return {
    value: {
      senderName,
      accentColor: accentValid ? accentOverride : DEFAULT_ACCENT,
      logoUrl: logoValid ? logoCandidate : null,
      footerText: footerOverride || `This message was sent on behalf of ${senderName}.`,
      office: {
        phone: nonblank(office.phone, 40),
        email: nonblank(office.email, 254),
        address: nonblank(office.address, 300),
      },
    },
    issues,
  };
}

/**
 * Resolve the branding model for an organization — the consumer read,
 * served by the Customer Configuration Framework (ADR-0016). Fail-safe:
 * with no store, unknown organization, or absent/malformed setting,
 * neutral defaults apply — a notification is never blocked on branding.
 */
function resolveBranding(configService, organizationKey) {
  const { readDomain } = require('../configuration/framework');
  return readDomain(configService, 'notification-branding', organizationKey).value;
}

module.exports = { resolveBranding, normalizeBrandingDocument, SETTINGS_NAMESPACE, BRANDING_KEY };
