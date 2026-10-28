/**
 * TD Marketing — What's New for the team (pure; dev job 9aec66fa, Addendum H, Antonio 28 Oct 2026: "I want a What's New where all new features or important news are posted there. For example we
 * deployed Documents but Rocco doesn't know anything."). Only Antonio posts. A post has an audience (everyone, sellers, setters), an optional link to a screen, and English and Italian text. When a
 * screen goes live the system PREPARES a draft; nothing reaches the team until Antonio approves it. No database here: `news-server.ts` loads and writes.
 */
import { MARKETING_PERMISSIONS } from "@/lib/marketing/permissions"
import { modulesFor } from "@/lib/marketing/workspace"
import type { Lang } from "@/lib/marketing/templates"

export const NEWS_AUDIENCES = ["everyone", "sellers", "setters"] as const
export type NewsAudience = (typeof NEWS_AUDIENCES)[number]
export const NEWS_TITLE_MAX = 120
export const NEWS_BODY_MAX = 2000
export const isNewsAudience = (v: unknown): v is NewsAudience => typeof v === "string" && (NEWS_AUDIENCES as readonly string[]).includes(v)

/** Who a post is for. A seller is a person who may pick leads (Rocco); a setter is a person who works the call list and may not pick (Ale's team). Antonio, who holds every permission, counts as a seller. */
export function audienceMatches(audience: string, perms: readonly string[]): boolean {
  if (audience === "sellers") return perms.includes("leads.pick")
  if (audience === "setters") return perms.includes("leads.worklist") && !perms.includes("leads.pick")
  return true
}

/** The screens a post can link to: the workspace menu, by its key (the link is worked out when it is shown, so a moved screen never leaves a dead link). */
export function linkTargets(): Array<{ key: string; label: string; href: string }> {
  return modulesFor(MARKETING_PERMISSIONS).filter(m => m.built).map(m => ({ key: m.key, label: m.label, href: m.href }))
}
export function hrefForLink(key: string | null | undefined): string | null {
  return linkTargets().find(m => m.key === key)?.href ?? null
}

export interface NewsInput { title: string; body: string; titleIt: string | null; bodyIt: string | null; linkKey: string | null; audience: NewsAudience }

/** What Antonio typed, checked. The Italian pair is optional (the team then reads the English text); a half-filled pair is refused so a title never shows without its text. */
export function validateNews(raw: unknown): { ok: true; value: NewsInput } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const title = str(r.title), body = str(r.body), titleIt = str(r.titleIt), bodyIt = str(r.bodyIt)
  if (!title) return { ok: false, error: "Write a title." }
  if (!body) return { ok: false, error: "Write the text of the news." }
  if (title.length > NEWS_TITLE_MAX) return { ok: false, error: `The title is too long (the limit is ${NEWS_TITLE_MAX} characters).` }
  if (body.length > NEWS_BODY_MAX || titleIt.length > NEWS_TITLE_MAX || bodyIt.length > NEWS_BODY_MAX) return { ok: false, error: `The text is too long (the limit is ${NEWS_BODY_MAX} characters).` }
  if (!!titleIt !== !!bodyIt) return { ok: false, error: "Fill in both the Italian title and the Italian text, or leave both empty." }
  const audience = r.audience === undefined || r.audience === "" ? "everyone" : r.audience
  if (!isNewsAudience(audience)) return { ok: false, error: "Pick who sees it: everyone, sellers or setters." }
  const linkKey = str(r.linkKey) || null
  if (linkKey && !linkTargets().some(m => m.key === linkKey)) return { ok: false, error: "That screen does not exist." }
  return { ok: true, value: { title, body, titleIt: titleIt || null, bodyIt: bodyIt || null, linkKey, audience } }
}

/** The text a person reads: Italian when he works in Italian and the post has it, else English. */
export function newsText(n: { title: string; body: string; title_it: string | null; body_it: string | null }, lang: Lang): { title: string; body: string } {
  return lang === "it" && n.title_it && n.body_it ? { title: n.title_it, body: n.body_it } : { title: n.title, body: n.body }
}

export interface Announcement { key: string; menuKey: string; audience: NewsAudience; title: string; body: string; titleIt: string; bodyIt: string }

/**
 * The screens that went live AFTER this feature existed. Each one waits as a DRAFT in Antonio's What's New until he approves or discards it (the decision is remembered by the key, so it never comes back).
 * A new screen in the workspace menu MUST be added here or to BASELINE_SCREENS: a unit test fails otherwise, so a screen can never go live without Antonio being asked to tell the team.
 */
export const ANNOUNCEMENTS: readonly Announcement[] = [
  {
    key: "documents", menuKey: "documents", audience: "everyone",
    title: "Documents is live",
    body: "The Documents tab is now in your menu. It holds the company overview and the description of Tony Durante LLC's services, in English and Italian. You can download them and, if your access allows it, upload new files or new versions.",
    titleIt: "Documenti è online",
    bodyIt: "La scheda Documenti è ora nel tuo menu. Contiene la presentazione dell'azienda e la descrizione dei servizi di Tony Durante LLC, in inglese e in italiano. Puoi scaricarli e, se il tuo accesso lo permette, caricare nuovi file o nuove versioni.",
  },
]

/** Screens that were already in the team's hands before What's New existed (28 Oct 2026): no draft is made for them. */
export const BASELINE_SCREENS: readonly string[] = [
  "home", "today", "call-list", "board", "leads", "calendar", "inbox", "whatsapp", "chat", "calls", "money", "offers", "content", "templates", "my-numbers", "activity", "reports", "team", "news",
]

/** The announcements Antonio has not decided yet (a decision is a news row with that feature key, posted or discarded). */
export function pendingAnnouncements(decidedKeys: ReadonlySet<string>): Announcement[] {
  return ANNOUNCEMENTS.filter(a => !decidedKeys.has(a.key))
}

/** Every screen in the menu is either old (baseline) or has an announcement. Used by the unit test. */
export function screensWithoutAnnouncementDecision(): string[] {
  const known = new Set<string>([...BASELINE_SCREENS, ...ANNOUNCEMENTS.map(a => a.menuKey)])
  return modulesFor(MARKETING_PERMISSIONS).map(m => m.key).filter(k => !known.has(k))
}

/** "Read by 1 of 2" and the names, for Antonio. The poster is not counted as a reader he is waiting for. */
export function readSummary(recipients: ReadonlyArray<{ id: string; name: string }>, readerIds: ReadonlySet<string>): { read: number; total: number; unread: string[] } {
  const unread = recipients.filter(r => !readerIds.has(r.id)).map(r => r.name)
  return { read: recipients.length - unread.length, total: recipients.length, unread }
}
