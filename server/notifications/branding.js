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
 * Resolve the branding model for an organization. Fail-safe: with no
 * Configuration Store, unknown organization, or absent setting, neutral
 * defaults apply — a notification is never blocked on branding.
 *
 * @param {object|null} configService
 * @param {string} organizationKey
 * @returns {{ senderName: string, accentColor: string, logoUrl: string|null,
 *             footerText: string, office: { phone: string|null, email: string|null, address: string|null } }}
 */
function resolveBranding(configService, organizationKey) {
  let organizationName = null;
  let overrides = {};
  if (configService) {
    try {
      const org = configService.organizations.get(organizationKey);
      organizationName = nonblank(org && org.name, 200);
    } catch { /* unknown organization — defaults apply */ }
    try {
      const setting = configService.settings.get(organizationKey, SETTINGS_NAMESPACE, BRANDING_KEY);
      if (setting && setting.value && typeof setting.value === 'object') overrides = setting.value;
    } catch { /* unset — defaults apply */ }
  }

  const senderName = nonblank(overrides.senderName, 200) || organizationName || 'Your law office';
  const office = overrides.office && typeof overrides.office === 'object' ? overrides.office : {};
  const logoUrl = nonblank(overrides.logoUrl, 500);

  return {
    senderName,
    accentColor: nonblank(overrides.accentColor, 16) || DEFAULT_ACCENT,
    logoUrl: logoUrl && logoUrl.startsWith('https://') ? logoUrl : null,
    footerText: nonblank(overrides.footerText, 500)
      || `This message was sent on behalf of ${senderName}.`,
    office: {
      phone: nonblank(office.phone, 40),
      email: nonblank(office.email, 254),
      address: nonblank(office.address, 300),
    },
  };
}

module.exports = { resolveBranding, SETTINGS_NAMESPACE, BRANDING_KEY };
