/**
 * Portal Tier Configuration
 *
 * Controls which features are visible at each portal tier.
 * Works as an ADDITIONAL gate on top of the existing navVisibility
 * (which checks if data exists). Both must pass for a feature to show.
 *
 * Tiers:
 * - lead: After call, offer sent. Can view offer, chat, profile.
 * - onboarding: After payment. Can fill data wizard, upload docs.
 * - active: After data reviewed. Can see services, invoices, deadlines.
 * - full: After EIN/completion. Everything visible.
 *
 * Account Types:
 * - Client: Annual management — full feature set per tier.
 * - One-Time: Standalone service — limited features (no billing/invoicing/customers/deadlines).
 */

export type PortalTier = 'lead' | 'onboarding' | 'active' | 'full'

// Which nav item keys are allowed at each tier
// Each tier INCLUDES all features from previous tiers
const TIER_FEATURES: Record<PortalTier, string[]> = {
  lead: [
    'dashboard',
    'offer',       // View/sign/pay offer
    'chat',
    'profile',
    'guide',
    'documents',   // Limited — only offer/contract docs
  ],
  onboarding: [
    'dashboard',
    'wizard',      // Data collection wizard
    'chat',
    'profile',
    'guide',
    'documents',   // Full document upload
  ],
  active: [
    'dashboard',
    'chat',
    'profile',
    'guide',
    'documents',
    'services',
    'pendingSignatures',
    'billing',
    'invoices',
    'deadlines',
    'activity',
    'customers',
    'referralManagement',
  ],
  full: [
    'dashboard',
    'chat',
    'profile',
    'guide',
    'documents',
    'services',
    'pendingSignatures',
    'billing',
    'invoices',
    'deadlines',
    'activity',
    'customers',
    'bankAccounts',
    'taxDocuments',
    'referralManagement',
  ],
}

// Partner portal features — partners only see referral management + basic comms
const PARTNER_FEATURES = [
  'dashboard',
  'referralManagement',
  'chat',
  'profile',
  'guide',
]

/**
 * Check if the portal user is a partner (referrer, not a client).
 * Partners have a stripped-down portal: Dashboard, Referrals, Chat, Settings, Guide.
 */
export function isPartnerPortal(portalRole: string | null | undefined): boolean {
  return portalRole === 'partner'
}

// Features excluded for One-Time accounts (standalone service customers)
// They get portal access but don't need annual management tools
const ONE_TIME_EXCLUDED = [
  'billing',       // No TD invoices/installments
  'invoices',      // No client invoicing tools
  'customers',     // No client database
  'deadlines',     // No recurring compliance
  'bankAccounts',  // No bank account setup
  'taxDocuments',  // No tax document section (they see docs in Documents tab)
  'activity',      // No activity feed
]

/**
 * Check if a feature is visible for the given tier and account type.
 * Returns true if the feature is allowed at this tier.
 * One-Time accounts have additional exclusions on top of tier permissions.
 */
export function isTierFeatureVisible(
  tier: PortalTier | string | null,
  featureKey: string,
  accountType?: string | null,
  portalRole?: string | null,
): boolean {
  // Partners get a stripped-down feature set regardless of tier
  if (isPartnerPortal(portalRole)) {
    return PARTNER_FEATURES.includes(featureKey)
  }

  const t = (tier || 'lead') as PortalTier // Default to most restricted tier, not 'active'
  const allowed = TIER_FEATURES[t]
  if (!allowed) return true // Unknown tier = show everything (safe fallback)
  if (!allowed.includes(featureKey)) return false
  if (accountType === 'One-Time' && ONE_TIME_EXCLUDED.includes(featureKey)) return false
  return true
}

/**
 * Get the dashboard variant for a given tier.
 * Controls what the main dashboard page shows.
 */
export function getDashboardVariant(tier: PortalTier | string | null): 'offer' | 'wizard' | 'services' | 'full' {
  switch (tier) {
    case 'lead': return 'offer'
    case 'onboarding': return 'wizard'
    case 'active': return 'services'
    case 'full': return 'full'
    default: return 'full'
  }
}
