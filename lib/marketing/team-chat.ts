/**
 * TD Marketing — the team's own chat: direct messages and groups, and @mentions (pure; dev job 9aec66fa, round 2 step 3). The rules only: who may be in a conversation, how a group is checked,
 * who a message is notified to, which people a text mentions. No database and no network; `team-chat-server.ts` reads and writes. The screen is the lead chat's own screen
 * (TD Talk's pieces), so everything TD Talk's chat can do is here too. The words and the files rules shared with the lead chat (`lead-chat.ts`) are not repeated.
 */
export const GROUP_TITLE_MAX = 80
export const MAX_GROUP_MEMBERS = 50

export interface ChatPerson { id: string; name: string }

/** The key of the direct message between two people: the same whoever starts it. */
export const dmKey = (a: string, b: string): string => [a, b].sort().join(":")

export type GroupCheck = { ok: true; title: string; memberIds: string[] } | { ok: false; error: string }

/**
 * A new group: a name, and at least one OTHER person; every person must be someone who may use the chat in this team (`allowed`). The creator is always in it, once.
 */
export function checkGroup(i: { title: unknown; memberIds: unknown; creatorId: string; allowed: ReadonlySet<string> }): GroupCheck {
  const title = typeof i.title === "string" ? i.title.trim().replace(/\s+/g, " ") : ""
  if (!title) return { ok: false, error: "Give the group a name." }
  if (title.length > GROUP_TITLE_MAX) return { ok: false, error: `The group name is too long (max ${GROUP_TITLE_MAX} characters).` }
  if (!Array.isArray(i.memberIds)) return { ok: false, error: "Pick the people for the group." }
  const others = Array.from(new Set((i.memberIds as unknown[]).filter((x): x is string => typeof x === "string"))).filter(id => id !== i.creatorId)
  if (others.length === 0) return { ok: false, error: "Pick at least one other person." }
  if (others.some(id => !i.allowed.has(id))) return { ok: false, error: "One of those people cannot be in this chat." }
  if (others.length + 1 > MAX_GROUP_MEMBERS) return { ok: false, error: `A group can have at most ${MAX_GROUP_MEMBERS} people.` }
  return { ok: true, title, memberIds: [i.creatorId, ...others] }
}

export type GroupAction =
  | { action: "rename"; title: unknown }
  | { action: "add"; memberIds: unknown }
  | { action: "leave" }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The people a text names with @: "@Cristina can you call?" -> Cristina's id. The full name must follow the @ and end at a word boundary; a longer name wins over a shorter one that is part of it
 * ("@Maria Rosa" is Maria Rosa, not Maria); the sender never counts; the same person once. Names are the ones the picker writes, so a person typing "@" and choosing always matches.
 */
export function parseMentions(text: string, people: readonly ChatPerson[], senderId: string): string[] {
  const out: string[] = []
  let rest = text
  for (const p of [...people].filter(x => x.id !== senderId && x.name.trim().length > 0).sort((a, b) => b.name.length - a.name.length)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])@${esc(p.name.trim())}(?![\\p{L}\\p{N}])`, "iu")
    if (re.test(rest)) {
      out.push(p.id)
      // take it out so a shorter name inside it ("@Maria" inside "@Maria Rosa") does not also match
      rest = rest.replace(new RegExp(`(^|[^\\p{L}\\p{N}])@${esc(p.name.trim())}(?![\\p{L}\\p{N}])`, "giu"), "$1")
    }
  }
  return Array.from(new Set(out))
}

/** Who is told about a message in a conversation: every other member who is active (not removed, not paused). */
export function threadRecipients(members: ReadonlyArray<{ user_id: string; status?: string }>, senderId: string): string[] {
  return Array.from(new Set(members.filter(m => m.user_id !== senderId && m.status !== "removed" && m.status !== "paused").map(m => m.user_id)))
}

/** The name a conversation is shown under: a group's own name; a direct message shows the OTHER person. */
export function threadTitle(t: { kind: "dm" | "group"; title: string | null; memberIds: readonly string[] }, meId: string, nameOf: (id: string) => string | undefined, fallback = "Chat"): string {
  if (t.kind === "group") return t.title || fallback
  const other = t.memberIds.find(id => id !== meId)
  return (other && nameOf(other)) || fallback
}

export interface ThreadRow { id: string; kind: "dm" | "group"; title: string; lastAt: string | null; last: string; lastBy: string; unread: number; mentioned: boolean; memberIds: string[] }

/** The list order: conversations with something new first, then the newest line first; an empty conversation (just started) last. */
export function sortThreads<T extends { unread: number; lastAt: string | null }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (b.unread > 0 ? 1 : 0) - (a.unread > 0 ? 1 : 0) || (b.lastAt ?? "").localeCompare(a.lastAt ?? ""))
}

/** The notification text: a mention says so; everything else shows who wrote where. */
export function threadPush(i: { senderName: string; threadTitle: string; kind: "dm" | "group" | "lead"; mentioned: boolean; preview: string }): { title: string; body: string } {
  if (i.mentioned) return { title: `${i.senderName} mentioned you · ${i.threadTitle}`, body: i.preview }
  return { title: i.kind === "dm" ? i.senderName : `${i.senderName} · ${i.threadTitle}`, body: i.preview }
}

/** Where a tapped notification goes: the Chat page with this conversation open. */
export const threadUrlFor = (threadId: string): string => `/marketing/chat?thread=${threadId}`
