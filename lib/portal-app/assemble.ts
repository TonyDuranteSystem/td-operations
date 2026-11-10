/**
 * Client iPhone app — the answer to "who am I and what can I open" (pure; dev job 056a70d0, Step 2).
 *
 * Takes the facts the portal already works out for the side menu (tier, flags, company, counts) and returns what the app needs:
 * every entry this person can open (in menu order, with its words and link in their language), their bottom bar, the number for the
 * Menu button, and the Pay switch. It uses the SAME menu rules as the website (`lib/portal/nav-rules.ts`), so the app can never
 * show an entry the website would hide, or the other way round. Loading the facts is `lib/portal-app/load.ts`; nothing here touches
 * a database.
 */
import {
  BOTTOM_NAV_ITEMS,
  navHubRule,
  navLabelKey,
  resolveNavHref,
  visibleMainItems,
  visibleTierTopItems,
  type NavRuleContext,
  type PortalNavItemDef,
} from '@/lib/portal/nav-rules'
import type { InProgressFormation, InProgressOnboarding } from '@/lib/portal/queries'
import { APP_BAR_SIZE, APP_EXCLUDED_KEYS, APP_LOCKED_KEY, effectiveBar, menuBadge, type AppNavItem } from '@/lib/portal-app/bar'

export interface AppMeInput {
  user: { name: string | null; email: string | null }
  kind: 'client' | 'teammate'
  locale: string
  /** Words in the person's language (the same lookup the portal screens use). */
  t: (key: string) => string
  /** The facts the portal's menu rule looks at. */
  ctx: NavRuleContext
  /** Which in-progress company is selected, for the wizard link. */
  selection: {
    selectedOnboardingId?: string
    selectedFormationId?: string
    inProgress: InProgressFormation[]
    inProgressOnboardings: InProgressOnboarding[]
  }
  company: { id: string; name: string } | null
  counts: { chat: number; documents: number; sign: number; billing: number }
  /** The bar the person chose (null = never chose). */
  savedBar: readonly string[] | null
  payEnabled: boolean
}

export interface AppMe {
  user: { name: string | null; email: string | null }
  kind: 'client' | 'teammate'
  locale: string
  company: { id: string; name: string } | null
  /** Everything this person can open, in menu order. */
  items: AppNavItem[]
  /** The bottom bar, as menu keys, in order. */
  bar: string[]
  /** The entry that always stays in the bar (Chat), or null when this person has no Chat. */
  lockedKey: string | null
  maxBarSize: number
  /** The number on the round Menu button. */
  menuBadge: number
  /** False hides the Pay button in the app (the switch Antonio asked for in case Apple objects). */
  payEnabled: boolean
}

/** The badge each entry carries, the same counters the side menu shows. */
function badgeFor(key: string, counts: AppMeInput['counts']): number {
  switch (key) {
    case 'nav.chat': return counts.chat
    case 'nav.documents': return counts.documents
    case 'nav.signDocuments': return counts.sign
    case 'nav.tdBilling': return counts.billing
    default: return 0
  }
}

export function assembleAppMe(input: AppMeInput): AppMe {
  const { ctx, selection, counts } = input
  const invoicesHubOn = navHubRule(ctx).hubLayout
  const ordered: PortalNavItemDef[] = [
    ...visibleTierTopItems(ctx),
    ...visibleMainItems(ctx),
    // Guide sits under its own gap at the end of the side menu and is shown to everyone.
    ...BOTTOM_NAV_ITEMS,
  ]
  const seen = new Set<string>()
  const items: AppNavItem[] = []
  for (const def of ordered) {
    if (APP_EXCLUDED_KEYS.includes(def.key) || seen.has(def.key)) continue
    seen.add(def.key)
    items.push({
      key: def.key,
      path: resolveNavHref(def, selection),
      // The approved bar and menu say plainly "Invoices" (the website's "Customers & Invoices" swap is for its own sidebar).
      label: input.t(def.key === 'nav.invoices' ? 'nav.invoices' : navLabelKey(def, { invoicesHubOn })),
      badge: Math.max(0, badgeFor(def.key, counts)),
    })
  }
  const available = items.map(i => i.key)
  const bar = effectiveBar(input.savedBar, available, ctx.portalTier)
  return {
    user: input.user,
    kind: input.kind,
    locale: input.locale,
    company: input.company,
    items,
    bar,
    lockedKey: available.includes(APP_LOCKED_KEY) ? APP_LOCKED_KEY : null,
    maxBarSize: APP_BAR_SIZE,
    menuBadge: menuBadge(items, bar),
    payEnabled: input.payEnabled,
  }
}
