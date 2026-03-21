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
    'billing',
    'invoices',
    'deadlines',
    'activity',
    'customers',
  ],
  full: [
    'dashboard',
    'chat',
    'profile',
    'guide',
    'documents',
    'services',
    'billing',
    'invoices',
    'deadlines',
    'activity',
    'customers',
    'bankAccounts',
    'taxDocuments',
  ],
}

/**
 * Check if a feature is visible for the given tier.
 * Returns true if the feature is allowed at this tier.
 */
export function isTierFeatureVisible(tier: PortalTier | string | null, featureKey: string): boolean {
  const t = (tier || 'lead') as PortalTier // Default to most restricted tier, not 'active'
  const allowed = TIER_FEATURES[t]
  if (!allowed) return true // Unknown tier = show everything (safe fallback)
  return allowed.includes(featureKey)
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
