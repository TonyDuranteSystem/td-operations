/** Plain-English names for the marketing permissions, for the Team page (pure, client-safe; TD Marketing, dev job 9aec66fa, Slice 2b). */
import { MARKETING_PERMISSIONS, type MarketingPermission } from "@/lib/marketing/permissions"

export const PERMISSION_LABELS: Record<MarketingPermission, string> = {
  "leads.read": "See the leads",
  "leads.pick": "Pick leads to work on",
  "leads.call": "See phone numbers and call leads",
  "leads.mark": "Mark leads Good, Not in target or Call back",
  "leads.worklist": "Work the call list and see My numbers",
  "leads.import": "Import old leads",
  "leads.export": "Export lead lists",
  "payment_links.create": "Create payment links",
  "money.read": "See the money pages",
  "offers.create": "Create offers",
  "calls.host": "Run the free and strategic calls",
  "calls.recordings": "Listen to call recordings",
  whatsapp: "Use WhatsApp",
  inbox: "Use the shared inbox",
  chat: "Use team chat",
  "content.manage": "Manage ads and content",
  "reports.read": "See reports",
  "team.activity": "See what the team did today",
  "team.notes": "See other people's notes and rejections",
  "team.manage": "Manage the team",
}

/** A permission's label; an unknown one is shown as itself so nothing is ever hidden. */
export function permissionLabel(p: string): string {
  return (PERMISSION_LABELS as Record<string, string>)[p] ?? p
}

/** The roles Antonio set up, in plain words (a role not listed here is shown from its key). */
export const ROLE_LABELS: Record<string, string> = { setter: "Setter", seller: "Seller", content: "Ad person", analyst: "Analyst (read only)" }

/** "setter" -> "Setter", "content_creator" -> "Content creator". */
export function roleLabel(key: string | null | undefined): string {
  if (!key) return "No role"
  if (ROLE_LABELS[key]) return ROLE_LABELS[key]
  const s = key.replace(/[_-]+/g, " ").trim()
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : key
}

/** A short line of what a list of permissions allows, in the order the permissions are defined. */
export function describePermissions(perms: readonly string[]): string {
  const set = new Set(perms)
  const known = MARKETING_PERMISSIONS.filter(p => set.has(p)).map(p => PERMISSION_LABELS[p])
  const unknown = perms.filter(p => !(MARKETING_PERMISSIONS as readonly string[]).includes(p))
  const all = [...known, ...unknown]
  return all.length ? all.join(", ") : "Nothing yet"
}

/** The permissions a person may hand out: an owner (or Antonio) every one, a member only those he holds. */
export function grantablePermissions(isOwner: boolean, mine: readonly string[]): MarketingPermission[] {
  return MARKETING_PERMISSIONS.filter(p => isOwner || mine.includes(p))
}
