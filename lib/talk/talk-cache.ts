// TD Talk inside the TD Social phone app (dev job 2072bc3e, "TD Talk opens slowly" fix A): the phone keeps the last chat list and the newest messages of the
// chat that was open, so opening TD Talk shows them AT ONCE and the real answer from the server replaces them a moment later. Pure rules + a tiny store over
// `localStorage` (browser only, every access guarded). Nothing here is trusted as truth: it is only what was on screen last time, shown until the server answers.
//
// Safety rules (each pinned by tests/unit/talk-cache.test.ts):
// - one saved copy per PERSON (the signed-in user's id): a copy saved for someone else is never shown and is replaced at the next save;
// - a copy older than 14 days, damaged, or of an unknown shape is ignored;
// - only the newest TALK_CACHE_KEEP_MESSAGES messages of each chat are kept (a chat is never stored whole), for the TALK_CACHE_KEEP_CHATS chats opened last
//   (dev job cf265457: opening a chat shows its saved messages at once instead of a spinner; the server's answer replaces them a moment later);
// - a saved chat is only ever shown, never acted on: it never marks anything read, never reports "delivered", never clears an unread number;
// - the app's sign-out already erases all of the web view's saved data, so the copy goes with it.

export const TALK_CACHE_KEY = 'td-talk-saved-v1'
export const TALK_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
export const TALK_CACHE_KEEP_MESSAGES = 60
/** How many chats (the ones opened last) are kept. */
export const TALK_CACHE_KEEP_CHATS = 6
/** A phone's web storage holds about 5 MB for the whole site: the saved copy stays well under, dropping the least recently opened chats first. */
export const TALK_CACHE_MAX_BYTES = 900_000
/** A saved chat not refreshed for this long is not shown (its messages could be days behind); the chat just opens the normal way. */
export const TALK_CACHE_CHAT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000
const REFRESH_STAMP_MS = 6 * 60 * 60 * 1000

/** What TD Talk's chat list answer holds that the screen uses (the rest of the answer is not kept). */
export interface SavedList {
  threads: unknown[]
  members: unknown[]
  current_user_id: string | null
}
/** One chat's answer: the same shape the server sends (`messages`, `has_more`, who read it...), with the messages cut to the newest ones. */
export interface SavedChat {
  id: string
  payload: Record<string, unknown>
  /** when this chat was last refreshed from the server (absent on copies saved before several chats were kept) */
  at?: number
}
export interface TalkSaved {
  v: 1
  userId: string
  savedAt: number
  list: SavedList
  /** the chat opened last */
  chat: SavedChat | null
  /** the chats opened before it, most recent first (absent on copies saved before several chats were kept) */
  more?: SavedChat[]
}

/** Cut a chat answer to its newest `keep` messages. When something was cut, `has_more` is true so "Load earlier messages" stays available. */
export function trimChatPayload(payload: Record<string, unknown>, keep: number = TALK_CACHE_KEEP_MESSAGES): Record<string, unknown> {
  const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : []
  if (messages.length <= keep) return { ...payload, messages }
  return { ...payload, messages: messages.slice(messages.length - keep), has_more: true }
}

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function asSavedChat(x: unknown): SavedChat | null {
  if (!isObject(x) || typeof x.id !== 'string' || !isObject(x.payload) || !Array.isArray(x.payload.messages)) return null
  const at = typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : undefined
  return at === undefined ? { id: x.id, payload: x.payload } : { id: x.id, payload: x.payload, at }
}

/** The saved copy for THIS person, or null (nothing saved, damaged, someone else's, too old, or not in the shape this code writes). */
export function parseSaved(raw: string | null, userId: string, now: number): TalkSaved | null {
  if (!raw || !userId) return null
  let d: unknown
  try { d = JSON.parse(raw) } catch { return null }
  if (!isObject(d) || d.v !== 1) return null
  if (d.userId !== userId) return null
  const savedAt = d.savedAt
  if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return null
  if (now - savedAt > TALK_CACHE_MAX_AGE_MS || savedAt - now > 24 * 60 * 60 * 1000) return null
  const list = d.list
  if (!isObject(list) || !Array.isArray(list.threads) || !Array.isArray(list.members)) return null
  const currentUserId = typeof list.current_user_id === 'string' ? list.current_user_id : null
  if (currentUserId && currentUserId !== userId) return null
  const chat = asSavedChat(d.chat)
  const more = Array.isArray(d.more) ? d.more.map(asSavedChat).filter((c): c is SavedChat => c !== null) : []
  return { v: 1, userId, savedAt, list: { threads: list.threads, members: list.members, current_user_id: currentUserId }, chat, ...(more.length ? { more } : {}) }
}

export function serializeSaved(s: TalkSaved): string {
  return JSON.stringify(s)
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** The one saved copy on this phone. Never throws: a phone that refuses to store anything just opens the slow way. */
export class TalkSavedStore {
  private current: TalkSaved | null = null
  private loaded = false
  private lastBody: string | null = null
  private lastWriteAt = 0
  /** a chat answer that arrived before the chat list did (they are asked for together): kept in memory and saved with the list */
  private waitingChat: SavedChat | null = null

  constructor(
    private readonly userId: string,
    private readonly storage: StorageLike | null,
    private readonly clock: () => number = Date.now,
  ) {}

  read(): TalkSaved | null {
    if (!this.storage) return null
    try {
      this.current = parseSaved(this.storage.getItem(TALK_CACHE_KEY), this.userId, this.clock())
    } catch { this.current = null }
    this.loaded = true
    return this.current
  }

  saveList(list: { threads?: unknown; members?: unknown; current_user_id?: unknown }): void {
    if (!Array.isArray(list.threads) || !Array.isArray(list.members)) return
    if (!this.loaded) this.read()
    const prior = [this.current?.chat ?? null, ...(this.current?.more ?? [])].filter((c): c is SavedChat => c !== null)
    const first = this.waitingChat ?? prior[0] ?? null
    const rest = prior.filter(c => c.id !== first?.id).slice(0, TALK_CACHE_KEEP_CHATS - 1)
    this.write({
      v: 1, userId: this.userId, savedAt: this.clock(),
      list: { threads: list.threads, members: list.members, current_user_id: typeof list.current_user_id === 'string' ? list.current_user_id : null },
      chat: first,
      ...(rest.length ? { more: rest } : {}),
    })
    this.waitingChat = null
  }

  /**
   * Keeps the chat that was just loaded as the most recent one, and the chats opened before it (up to TALK_CACHE_KEEP_CHATS).
   * A chat without its list would open to nothing, so one that arrives first waits for the list.
   */
  saveChat(id: string, payload: Record<string, unknown>): void {
    if (!id || !Array.isArray(payload.messages)) return
    if (!this.loaded) this.read()
    const trimmed = trimChatPayload(payload)
    const now = this.clock()
    const prior = [this.current?.chat ?? null, ...(this.current?.more ?? [])].filter((c): c is SavedChat => c !== null)
    // a refresh that changed nothing keeps its time stamp (so the copy is not rewritten every 10 seconds); a stamp is renewed every few hours so it never expires while the chat is in use
    const same = prior.find(c => c.id === id)
    const keepStamp = same?.at !== undefined && now - same.at < REFRESH_STAMP_MS && JSON.stringify(same.payload) === JSON.stringify(trimmed)
    const chat: SavedChat = { id, payload: trimmed, at: keepStamp && same?.at !== undefined ? same.at : now }
    if (!this.current) { this.waitingChat = chat; return }
    this.write({ ...this.current, savedAt: now, chat, more: prior.filter(c => c.id !== id).slice(0, TALK_CACHE_KEEP_CHATS - 1) })
  }

  /** The saved copy of one chat, or null (never saved, or not refreshed for days). Only for showing while the server's answer is on its way. */
  chatFor(id: string): SavedChat | null {
    if (!id) return null
    if (!this.loaded) this.read()
    const cur = this.current
    if (!cur) return null
    const found = [cur.chat, ...(cur.more ?? [])].find(c => c?.id === id) ?? null
    if (!found) return null
    if (found.at !== undefined && this.clock() - found.at > TALK_CACHE_CHAT_MAX_AGE_MS) return null
    return found
  }

  clear(): void {
    this.current = null
    this.lastBody = null
    this.waitingChat = null
    try { this.storage?.removeItem(TALK_CACHE_KEY) } catch { /* nothing to do */ }
  }

  private write(requested: TalkSaved): void {
    const next = fitToBudget(requested)
    this.current = next
    if (!this.storage) return
    try {
      // the time changes on every save; only a real change in what is kept is written (the 10-second refresh usually changes nothing),
      // except that an unchanged copy is stamped again every few hours so a phone opened daily never lets it expire
      const now = this.clock()
      const body = serializeSaved({ ...next, savedAt: 0 })
      if (body === this.lastBody && now - this.lastWriteAt < REFRESH_STAMP_MS) return
      this.storage.setItem(TALK_CACHE_KEY, serializeSaved(next))
      this.lastBody = body
      this.lastWriteAt = now
    } catch { /* storage full or refused: skip */ }
  }
}

/** Drops the least recently opened chats until the saved copy fits the budget (the chat opened last is always kept). */
function fitToBudget(s: TalkSaved): TalkSaved {
  let more = s.more ?? []
  let out: TalkSaved = s
  while (more.length > 0 && serializeSaved(out).length > TALK_CACHE_MAX_BYTES) {
    more = more.slice(0, -1)
    out = { ...s, more }
  }
  return out
}

/** Which chat the screen should show right away, before the server has said which chats exist: the one a tap or link asked for, else the one open last time. */
export function earlyChatChoice(wanted: string | null | undefined, lastOpened: string | null | undefined): string | null {
  return wanted || lastOpened || null
}

/** After the real chat list is in: is the chat shown early still the right one? */
export function afterListChoice(shown: string | null, firstFromServer: string | null): 'keep' | 'select' | 'clear' {
  if (shown === firstFromServer) return 'keep'
  return firstFromServer ? 'select' : 'clear'
}

/** The fast opening is for the phone app's TD Talk screen only (the CRM tab and a normal browser keep the way they always opened). */
export function fastOpenEnabled(appMode: boolean, isTalkApp: boolean): boolean {
  return appMode && isTalkApp
}
