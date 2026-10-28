/**
 * TD Marketing — Antonio's menu (pure; dev job 9aec66fa, Addendum H, 28 Oct 2026: "I want a dashboard where I can see everything and act as well"). ONE list, shown on every Marketing screen he opens,
 * whether the screen lives in his CRM section or in the team workspace. The screens in the workspace are the same ones Rocco uses; only the frame around them is his. A link to a workspace screen is
 * checked against the workspace's own menu by a unit test, so a renamed screen can never leave a dead link here.
 */
export interface OwnerLink { key: string; label: string; href: string }
export interface OwnerItem extends OwnerLink { exact?: true; children?: OwnerLink[]; admin?: true }

export const OWNER_MENU: readonly OwnerItem[] = [
  { key: "home", label: "Home", href: "/marketing-leads", exact: true },
  { key: "news", label: "What's New", href: "/marketing-leads/news" },
  { key: "leads", label: "Leads", href: "/marketing-leads/leads" },
  { key: "board", label: "Board", href: "/marketing/board" },
  { key: "calendar", label: "Calendar", href: "/marketing/calendar" },
  { key: "messages", label: "Messages", href: "/marketing/chat", children: [
    { key: "chat", label: "Chat", href: "/marketing/chat" },
    { key: "inbox", label: "Inbox", href: "/marketing/inbox" },
    { key: "whatsapp", label: "WhatsApp", href: "/marketing/whatsapp" },
  ] },
  { key: "documents", label: "Documents", href: "/marketing/documents" },
  { key: "money", label: "Money", href: "/marketing-leads/money" },
  { key: "team", label: "Team", href: "/marketing-leads/teams", children: [
    { key: "activity", label: "Team activity", href: "/marketing/activity" },
    { key: "reports", label: "Reports", href: "/marketing/reports" },
  ] },
  { key: "templates", label: "Templates", href: "/marketing/templates" },
  { key: "settings", label: "Settings", href: "/marketing-leads/settings", admin: true },
  { key: "audit", label: "Audit log", href: "/marketing-leads/audit", admin: true },
]

const hit = (path: string, href: string, exact?: boolean) => (exact ? path === href : path === href || path.startsWith(`${href}/`))

/** Which entry is open for this address: the entry itself, or one of its sub-links (then the entry is open too and its sub-links show). */
export function activeOwnerItem(path: string): { item: string | null; child: string | null } {
  for (const it of OWNER_MENU) {
    const c = it.children?.find(x => hit(path, x.href))
    if (c) return { item: it.key, child: c.key }
    if (hit(path, it.href, it.exact)) return { item: it.key, child: null }
  }
  return { item: null, child: null }
}
