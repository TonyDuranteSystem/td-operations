/**
 * TD Marketing — what a person can see and do, in words (pure; dev job 9aec66fa, access popup). A person's access is stored as their EXACT list of permissions. A role is
 * only a preset that fills the list in. From the list we derive which roles it still looks like ("Seller, 2 changes") so the Team page can say it, the invite popup
 * can preview the menu, and warnings can point at odd combinations. No database here.
 */
import { MARKETING_PERMISSIONS, cleanPermissions } from "@/lib/marketing/permissions"
import { PERMISSION_LABELS, roleLabel } from "@/lib/marketing/permission-labels"
import { homeFor, modulesFor } from "@/lib/marketing/workspace"

export type Bundles = Record<string, readonly string[]>

export interface AccessSummary {
  /** the roles the list still matches (at most a third of a role missing counts as matching) */
  roles: string[]
  /** held but not part of any matching role */
  added: string[]
  /** part of a matching role but not held */
  missing: string[]
}

/** The union of these roles' permissions (a role that no longer exists adds nothing). */
export function permissionsOfRoles(roles: readonly string[], bundles: Bundles): string[] {
  return cleanPermissions(roles.flatMap(r => bundles[r] ?? []))
}

/** All the ways to pick some of these keys (the roles are few, so this stays small). */
function subsets(keys: readonly string[]): string[][] {
  const out: string[][] = []
  const n = Math.min(keys.length, 10)
  for (let m = 1; m < 1 << n; m++) out.push(keys.slice(0, n).filter((_, i) => m & (1 << i)))
  return out
}

/**
 * Which roles this exact list is built from, and how it differs. We try every combination of the roles and keep the one that needs the fewest changes (fewer roles on a tie);
 * if even the best one needs more than 40% of the list changed, the access is custom and no role is named.
 */
export function describeAccess(list: readonly string[], bundles: Bundles): AccessSummary {
  const have = new Set<string>(cleanPermissions(list))
  const diff = (roles: string[]) => {
    const union = new Set<string>(permissionsOfRoles(roles, bundles))
    return { roles, added: Array.from(have).filter(p => !union.has(p)), missing: Array.from(union).filter(p => !have.has(p)) }
  }
  const keys = Object.keys(bundles).filter(k => cleanPermissions(bundles[k] ?? []).length > 0)
  let best: AccessSummary | null = null
  for (const s of subsets(keys)) {
    const d = diff(s)
    const cost = d.added.length + d.missing.length
    const bestCost = best ? best.added.length + best.missing.length : Infinity
    if (cost < bestCost || (cost === bestCost && best && s.length < best.roles.length)) best = d
  }
  if (!best) return { roles: [], added: Array.from(have), missing: [] }
  const cost = best.added.length + best.missing.length
  return cost > Math.max(3, Math.floor(have.size * 0.4)) ? { roles: [], added: Array.from(have), missing: [] } : best
}

/** "Setter + Analyst (read only), 2 changes" */
export function accessLabel(list: readonly string[], bundles: Bundles): string {
  const d = describeAccess(list, bundles)
  const n = d.added.length + d.missing.length
  const name = d.roles.length ? d.roles.map(roleLabel).join(" + ") : "Custom access"
  return n > 0 && d.roles.length ? `${name}, ${n} change${n === 1 ? "" : "s"}` : name
}

/** "added See reports; without See phone numbers…" for the changes line. */
export function changeLines(d: AccessSummary): string[] {
  const l = (p: string) => (PERMISSION_LABELS as Record<string, string>)[p] ?? p
  return [...d.added.map(p => `added: ${l(p)}`), ...d.missing.map(p => `without: ${l(p)}`)]
}

/** What the person's menu will show (every screen that exists, on or off), in the real menu's own order, and the screen they land on. Uses the very same rules as the live menu, so it cannot disagree with it. */
export function previewMenu(list: readonly string[]): { items: Array<{ key: string; label: string; on: boolean }>; home: string | null } {
  const on = new Set(modulesFor(list).map(m => m.key))
  const home = homeFor(list)
  const have = modulesFor(list)
  return {
    items: modulesFor([...MARKETING_PERMISSIONS]).filter(m => m.built).map(m => ({ key: m.key, label: m.label, on: on.has(m.key) })),
    home: have.find(m => m.href === home)?.label ?? null,
  }
}

export interface AccessWarning { text: string; fixPermission: string | null; fixLabel: string | null }

/** Odd combinations worth a second look. Each is a question, not an error. */
export function accessWarnings(list: readonly string[]): AccessWarning[] {
  const has = (p: string) => list.includes(p)
  const out: AccessWarning[] = []
  if (has("payment_links.create") && !has("money.read")) out.push({ text: "Can create payment links but cannot see the Money pages, so cannot check whether they were paid.", fixPermission: "money.read", fixLabel: "Also give the Money pages" })
  if (has("leads.pick") && !has("leads.call")) out.push({ text: "Can pick leads but not see phone numbers. People who pick usually need them.", fixPermission: "leads.call", fixLabel: "Give phone numbers" })
  if (has("team.activity") && !has("team.notes")) out.push({ text: "Sees the team's numbers but not what people wrote.", fixPermission: "team.notes", fixLabel: "Also show notes" })
  if (has("leads.worklist") && !has("leads.read")) out.push({ text: "Has the Call list but cannot see the leads, so the list would be empty.", fixPermission: "leads.read", fixLabel: "Let them see the leads" })
  if (has("leads.mark") && !has("leads.read")) out.push({ text: "Can mark leads but cannot see the leads list.", fixPermission: "leads.read", fixLabel: "Let them see the leads" })
  return out
}

/** The permissions as the popup lists them: four groups, each tick is one or more permissions (import and export are one tick). */
export const ACCESS_GROUPS: ReadonlyArray<{ group: string; items: ReadonlyArray<{ label: string; keys: readonly string[] }> }> = [
  { group: "Leads", items: [
    { label: PERMISSION_LABELS["leads.read"], keys: ["leads.read"] }, { label: PERMISSION_LABELS["leads.call"], keys: ["leads.call"] },
    { label: PERMISSION_LABELS["leads.mark"], keys: ["leads.mark"] }, { label: PERMISSION_LABELS["leads.pick"], keys: ["leads.pick"] },
    { label: PERMISSION_LABELS["leads.worklist"], keys: ["leads.worklist"] }, { label: "Import and export leads", keys: ["leads.import", "leads.export"] },
  ] },
  { group: "Team", items: [
    { label: PERMISSION_LABELS["team.activity"], keys: ["team.activity"] }, { label: PERMISSION_LABELS["team.notes"], keys: ["team.notes"] }, { label: PERMISSION_LABELS["reports.read"], keys: ["reports.read"] },
  ] },
  { group: "Money", items: [
    { label: PERMISSION_LABELS["money.read"], keys: ["money.read"] }, { label: PERMISSION_LABELS["payment_links.create"], keys: ["payment_links.create"] }, { label: PERMISSION_LABELS["offers.create"], keys: ["offers.create"] },
  ] },
  { group: "Talk", items: [
    { label: PERMISSION_LABELS.whatsapp, keys: ["whatsapp"] }, { label: PERMISSION_LABELS.inbox, keys: ["inbox"] }, { label: PERMISSION_LABELS.chat, keys: ["chat"] },
    { label: PERMISSION_LABELS["calls.host"], keys: ["calls.host"] }, { label: PERMISSION_LABELS["calls.recordings"], keys: ["calls.recordings"] },
  ] },
]

/** Every permission appears in exactly one popup tick, except team.manage (its own warned row) and content.manage (not built yet). */
export const NOT_IN_GROUPS: readonly string[] = ["team.manage", "content.manage"]
export const ALL_GROUPED = MARKETING_PERMISSIONS.filter(p => !NOT_IN_GROUPS.includes(p))
