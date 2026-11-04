'use client'

/**
 * The queue for changes to messages already sent (edit, delete, react) — browser only. Same idea as the message outbox (`outbox.ts`): the change is written to the phone's own
 * storage first, shown at once, and sent as soon as it can be, by itself when the connection is back; closing the app loses nothing. Rules are in `outbox-actions-rules.ts`.
 * "No connection / timeout / busy" keeps the change and tries again later (3 s, 6 s … 30 s); a real "no" from the server (not your message, message gone, too long) drops the change,
 * tells the person why, and the screen reloads the chat so it shows the truth.
 */
import { actionOrder, addAction, classifyAnswer, SERVER_ERROR_LIMIT, type ChatAction } from '@/lib/talk/outbox-actions-rules'
import { retryDelayMs } from '@/lib/talk/outbox-rules'

const DB_NAME = 'td-chat-actions'
const STORE = 'items'
const POST_TIMEOUT_MS = 30_000

let items: ChatAction[] = []
let loaded: Promise<void> | null = null
let running = false
let again = false
let failedRounds = 0
let timer: ReturnType<typeof setTimeout> | null = null
let lastUser: string | null = null
const changeListeners = new Set<() => void>()
const doneListeners = new Set<(action: ChatAction, result: unknown) => void>()
const failedListeners = new Set<(action: ChatAction, error: string) => void>()

function openDb(): Promise<IDBDatabase | null> {
  return new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE, { keyPath: 'id' }) } catch { /* already there */ } }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
}
async function dbWrite(run: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      run(tx.objectStore(STORE))
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); resolve() }
    } catch { try { db.close() } catch { /* ignore */ } resolve() }
  })
}
async function dbAll(): Promise<ChatAction[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise<ChatAction[]>(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () => { db.close(); resolve((req.result as ChatAction[]) ?? []) }
      req.onerror = () => { db.close(); resolve([]) }
    } catch { try { db.close() } catch { /* ignore */ } resolve([]) }
  })
}
/** Ids taken out of the waiting list in THIS tab (sent, refused, collapsed away): only these are deleted from storage, so a second open tab never erases the other tab's waiting changes. */
const removed = new Set<string>()
let persistChain: Promise<void> = Promise.resolve()
/** Writes the waiting list: stores what is there, deletes what this tab removed. One write at a time, in order, so an older snapshot can never land after a newer one. */
function persist(): Promise<void> {
  persistChain = persistChain.then(async () => {
    const now = items
    const gone = Array.from(removed)
    removed.clear()
    await dbWrite(store => {
      for (const id of gone) store.delete(id)
      for (const i of now) store.put(i)
    })
  })
  return persistChain
}

/** Replaces the waiting list and remembers which ones left it (to delete them from storage). */
function setItems(next: ChatAction[]) {
  for (const prev of items) if (!next.some(i => i.id === prev.id)) removed.add(prev.id)
  items = next
}

function emit() { for (const fn of Array.from(changeListeners)) { try { fn() } catch { /* a listener must never break the queue */ } } }

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = dbAll().then(stored => {
      // what the phone kept from last time first, then what was made since this page opened ON TOP: the newer change always wins
      let list: ChatAction[] = []
      for (const s of actionOrder(stored)) if (s && s.id) list = addAction(list, s)
      for (const cur of actionOrder(items)) list = addAction(list, cur)
      for (const s of stored) if (s && s.id && !list.some(i => i.id === s.id)) removed.add(s.id) // collapsed away: forget it in storage too
      items = list
      emit()
    })
  }
  return loaded
}

// ── reading ──
/** The waiting changes of one chat made by one person (a shared phone never draws Luca's waiting change over Antonio's chat). */
export function waitingActions(threadId: string, userId: string | null): ChatAction[] { return actionOrder(items.filter(i => i.threadId === threadId && i.senderId === userId)) }
export function subscribeActions(fn: () => void): () => void { changeListeners.add(fn); return () => { changeListeners.delete(fn) } }
export function onActionDone(fn: (action: ChatAction, result: unknown) => void): () => void { doneListeners.add(fn); return () => { doneListeners.delete(fn) } }
export function onActionFailed(fn: (action: ChatAction, error: string) => void): () => void { failedListeners.add(fn); return () => { failedListeners.delete(fn) } }
export async function loadActions(): Promise<void> { await ensureLoaded() }

// ── writing ──
/** Keeps the change (storage first) and starts sending. Resolves as soon as it is safely kept — the screen already shows it. */
export async function enqueueAction(action: ChatAction): Promise<void> {
  setItems(addAction(items, action))
  emit()
  await ensureLoaded()
  await persist()
  lastUser = action.senderId
  failedRounds = 0
  void flushActions(action.senderId)
}

// ── sending ──
type Outcome = { ok: true; result: unknown } | { ok: false; permanent: boolean; server: boolean; error: string }
// (the project's loose type settings do not narrow a union on `ok`, so the failed case is named explicitly)
const failed = (o: Outcome): o is Extract<Outcome, { ok: false }> => o.ok === false

async function sendOnce(a: ChatAction): Promise<Outcome> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    const base = `/api/team/messages/${a.messageId}`
    const res = a.kind === 'edit'
      ? await fetch(base, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: a.text }), signal: controller.signal })
      : a.kind === 'delete'
        ? await fetch(base, { method: 'DELETE', signal: controller.signal })
        : await fetch(`${base}/react`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji: a.emoji, on: a.on }), signal: controller.signal })
    const d = await res.json().catch(() => null)
    const verdict = classifyAnswer(res.status, d)
    if (verdict.kind === 'done') return { ok: true, result: d }
    if (verdict.kind === 'refused') return { ok: false, permanent: true, server: false, error: verdict.error }
    return { ok: false, permanent: false, server: verdict.server, error: verdict.error }
  } catch (e) {
    // no connection / aborted (slow): worth another try later
    return { ok: false, permanent: false, server: false, error: e instanceof Error && e.message ? e.message : 'No connection.' }
  } finally { clearTimeout(t) }
}

/** One round, oldest change first. A refusal drops only that change; "no connection" stops the round and tries again after a pause (changes must stay in order). */
export async function flushActions(userId: string): Promise<void> {
  lastUser = userId
  await ensureLoaded()
  if (running) { again = true; return }
  running = true
  try {
    let offline = false
    do {
      again = false
      if (timer) { clearTimeout(timer); timer = null }
      for (const a of actionOrder(items)) {
        if (a.senderId !== userId) continue
        if (!items.some(i => i.id === a.id)) continue // collapsed away while an earlier one was being sent
        const r = await sendOnce(a)
        if (!failed(r)) {
          setItems(items.filter(i => i.id !== a.id))
          await persist(); failedRounds = 0; emit()
          for (const fn of Array.from(doneListeners)) { try { fn(a, r.result) } catch { /* ignore */ } }
        } else if (r.permanent || (r.server && (a.serverErrors ?? 0) + 1 >= SERVER_ERROR_LIMIT)) {
          // a real "no", or the server keeps failing on this one change: drop it (told to the person) so it cannot block every later change
          setItems(items.filter(i => i.id !== a.id))
          await persist(); emit()
          const why = r.permanent ? r.error : 'The server could not save it. Please try again.'
          for (const fn of Array.from(failedListeners)) { try { fn(a, why) } catch { /* ignore */ } }
        } else {
          a.attempts += 1
          if (r.server) a.serverErrors = (a.serverErrors ?? 0) + 1
          await persist(); emit()
          offline = true
          break
        }
      }
    } while (again && !offline)
    if (offline) {
      const wait = retryDelayMs(failedRounds)
      failedRounds += 1
      timer = setTimeout(() => { timer = null; if (lastUser) void flushActions(lastUser) }, wait)
    }
  } finally { running = false }
}

/** Test hook: forget everything in memory. */
export function resetActionsForTests(): void { removed.clear(); persistChain = Promise.resolve(); items = []; loaded = null; running = false; again = false; failedRounds = 0; if (timer) clearTimeout(timer); timer = null; lastUser = null; changeListeners.clear(); doneListeners.clear(); failedListeners.clear() }
