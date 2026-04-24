/**
 * Portal Tier Configuration — Single Canonical Source
 *
 * Controls which features are visible at each portal tier.
 * Works as an ADDITIONAL gate on top of the existing navVisibility
 * (which checks if data exists). Both must pass for a feature to show.
 *
 * Tiers (in order):
 * - lead:       After call, offer sent. Can view offer, chat, profile.
 * - formation:  After payment for formation services. Wizard + docs + signatures.
 * - onboarding: After company formed / EIN obtained. Can fill data wizard, upload docs.
 * - active:     After data reviewed. Can see services, invoices, deadlines.
 *
 * Account Types:
 * - Client: Annual management — full feature set per tier.
 * - One-Time: Standalone service — limited features (no billing/invoicing/customers/deadlines).
 */

export type PortalTier = 'lead' | 'formation' | 'onboarding' | 'active'

export const PORTAL_TIERS = ['lead', 'formation', 'onboarding', 'active'] as const

export const TIER_ORDER: Record<PortalTier, number> = {
  lead: 0,
  formation: 1,
  onboarding: 2,
  active: 3,
}

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
  formation: [
    'dashboard',
    'wizard',      // Data collection wizard
    'chat',
    'profile',
    'guide',
    'documents',   // Full document upload
    'pendingSignatures', // SS-4, OA, lease signing during formation
  ],
  onboarding: [
    'dashboard',
    'wizard',      // Data collection wizard
    'chat',
    'profile',
    'guide',
    'documents',   // Full document upload
    'pendingSignatures', // SS-4, OA, lease signing during formation
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
    'documentGenerator',
  ],
}

// Partner portal features — partners see clients, invoices, referrals + basic comms
const PARTNER_FEATURES = [
  'dashboard',
  'partnerClients',
  'partnerInvoices',
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
  if (!allowed) return false // Unknown tier = hide everything (security: fail closed)
  if (!allowed.includes(featureKey)) return false
  if (accountType === 'One-Time' && ONE_TIME_EXCLUDED.includes(featureKey)) return false
  return true
}

/**
 * Get the dashboard variant for a given tier.
 * Controls what the main dashboard page shows.
 */
export function getDashboardVariant(tier: PortalTier | string | null): 'offer' | 'wizard' | 'services' {
  switch (tier) {
    case 'lead': return 'offer'
    case 'formation': return 'wizard'
    case 'onboarding': return 'wizard'
    case 'active': return 'services'
    default: return 'offer' // Unknown tier → most restricted view
  }
}
