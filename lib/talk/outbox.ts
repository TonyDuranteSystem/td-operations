'use client'

/**
 * The outbox (browser only): a chat message that cannot be delivered right away is kept on the phone and sent as soon as possible (Antonio, 2 Nov 2026: a voice note
 * failed to upload on the phone and was thrown away). It is written to the phone's own storage (IndexedDB) BEFORE the first try, so closing the app or restarting the
 * phone loses nothing; it goes out in the order written, by itself when the connection is back, and under its own id so a second try can never post it twice.
 * The rules are in `outbox-rules.ts`; TD Talk and both TD Marketing chats use this one engine.
 */
import { isPermanentError } from '@/lib/chat/upload-with-retry'
import { uploadTeamAttachment } from '@/lib/team/attachment'
import { uploadLeadAttachment } from '@/lib/marketing/lead-chat-upload'
import { isPermanentStatus, retryDelayMs, sendOrder, type OutboxItem } from '@/lib/talk/outbox-rules'

const DB_NAME = 'td-chat-outbox'
const STORE = 'items'
/** A queued upload gets a long time per try (a voice note on a weak signal): the engine itself comes back later, so the quick 6-second tries of the normal upload are not enough. */
const UPLOAD_RETRY = { attempts: 2, attemptTimeoutMs: 90_000, baseDelayMs: 1000, maxDelayMs: 3000 }
const POST_TIMEOUT_MS = 30_000

let items: OutboxItem[] = []
let loaded: Promise<void> | null = null
let running = false
let again = false
let failedRounds = 0
let timer: ReturnType<typeof setTimeout> | null = null
let lastUser: string | null = null
/** Ids the person deleted while their send was already under way: the send must stop before it posts anything. */
const discarded = new Set<string>()
const changeListeners = new Set<() => void>()
const sentListeners = new Set<(item: OutboxItem, message: unknown) => void>()

// ── storage (best effort: where the phone refuses it, the queue still works until the page is closed) ──
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
async function dbPut(item: OutboxItem): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(item)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); resolve() }
    } catch { try { db.close() } catch { /* ignore */ } resolve() }
  })
}
async function dbDelete(id: string): Promise<void> {
  const db = await openDb()
  if (!db) return
  await new Promise<void>(resolve => {
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(id)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => { db.close(); resolve() }
      tx.onabort = () => { db.close(); resolve() }
    } catch { try { db.close() } catch { /* ignore */ } resolve() }
  })
}
async function dbAll(): Promise<OutboxItem[]> {
  const db = await openDb()
  if (!db) return []
  return new Promise<OutboxItem[]>(resolve => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).getAll()
      req.onsuccess = () => { db.close(); resolve((req.result as OutboxItem[]) ?? []) }
      req.onerror = () => { db.close(); resolve([]) }
    } catch { try { db.close() } catch { /* ignore */ } resolve([]) }
  })
}

function emit() { for (const fn of Array.from(changeListeners)) { try { fn() } catch { /* a listener must never break the queue */ } } }

/** Reads what the phone kept from last time (once). Items found in memory (just queued) win over stored ones. */
function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = dbAll().then(stored => {
      const have = new Set(items.map(i => i.id))
      for (const s of stored) if (s && s.id && !have.has(s.id)) items.push({ ...s, files: Array.isArray(s.files) ? s.files : [], uploaded: Array.isArray(s.uploaded) ? s.uploaded : [] })
      emit()
    })
  }
  return loaded
}

// ── reading ──
export function waitingFor(scope: string): OutboxItem[] { return sendOrder(items.filter(i => i.scope === scope)) }
export function subscribeOutbox(fn: () => void): () => void { changeListeners.add(fn); return () => { changeListeners.delete(fn) } }
export function onOutboxSent(fn: (item: OutboxItem, message: unknown) => void): () => void { sentListeners.add(fn); return () => { sentListeners.delete(fn) } }
/** Loads the stored items and returns when they are known (the chat shows them from then on). */
export async function loadOutbox(): Promise<void> { await ensureLoaded() }

// ── writing ──
/** Puts a message in the queue (storage first) and starts sending. Resolves as soon as it is safely kept — the screen shows it at once. */
export async function enqueueMessage(item: OutboxItem): Promise<void> {
  items.push(item)
  emit()
  await ensureLoaded()
  await dbPut(item)
  lastUser = item.senderId
  failedRounds = 0
  void flushOutbox(item.senderId)
}

/** "Retry" on a message that was refused: tries again now. */
export async function retryMessage(id: string, userId: string): Promise<void> {
  const it = items.find(i => i.id === id)
  if (!it) return
  it.state = 'pending'; it.error = undefined; it.attempts = 0
  emit()
  await dbPut(it)
  failedRounds = 0
  void flushOutbox(userId)
}

/** "Delete" on a message that was never sent: forgets it (nothing was posted, so nobody else sees anything). */
export async function discardMessage(id: string): Promise<void> {
  discarded.add(id)
  items = items.filter(i => i.id !== id)
  emit()
  await dbDelete(id)
}

// ── sending ──
type Outcome = { ok: true; message: unknown } | { ok: false; permanent: boolean; error: string }
const failed = (o: Outcome): o is Extract<Outcome, { ok: false }> => o.ok === false

async function postOnce(url: string, body: unknown): Promise<Response> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    return await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal })
  } finally { clearTimeout(t) }
}

async function sendItem(it: OutboxItem): Promise<Outcome> {
  try {
    for (let i = 0; i < it.files.length; i++) {
      if (it.uploaded[i]) continue
      const f = it.files[i]
      const file = new File([f.blob], f.name, { type: f.type })
      it.uploaded[i] = it.target.kind === 'talk'
        ? await uploadTeamAttachment(file, it.target.threadId, UPLOAD_RETRY)
        : await uploadLeadAttachment(file, it.target.id, it.target.api, UPLOAD_RETRY)
      await dbPut(it) // the file is on the server now: a restart does not send it again
    }
    if (discarded.has(it.id)) return { ok: false, permanent: true, error: 'Deleted.' } // deleted while the files were going up: nothing is posted
    const url = it.target.kind === 'talk' ? `/api/team/threads/${it.target.threadId}/messages` : `${it.target.api}/${it.target.id}/messages${it.target.laneQs}`
    const res = await postOnce(url, { message: it.text, reply_to_id: it.replyToId, attachments: it.uploaded.length ? it.uploaded : null, client_id: it.id, sender_id: it.senderId })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      return { ok: false, permanent: isPermanentStatus(res.status), error: (d && typeof d.error === 'string' && d.error) || 'Could not send. Please try again.' }
    }
    const d = await res.json().catch(() => null)
    return { ok: true, message: d?.message ?? null }
  } catch (e) {
    const permanent = isPermanentError(e)
    return { ok: false, permanent, error: e instanceof Error && e.message ? e.message : 'Could not send. Please try again.' }
  }
}

/** One round: every message of this person, oldest first. A refusal stops only that message; "no connection" holds that chat's later messages (they must stay in order). */
export async function flushOutbox(userId: string): Promise<void> {
  lastUser = userId
  await ensureLoaded()
  if (running) { again = true; return }
  running = true
  try {
    // a chat that found no connection stays held for the rest of this run (its later messages must not jump the queue, and the pause below decides when to try again)
    const held = new Set<string>()
    let offline = false
    do {
      again = false
      if (timer) { clearTimeout(timer); timer = null }
      for (const it of sendOrder(items)) {
        if (it.senderId !== userId || it.state !== 'pending' || held.has(it.scope)) continue
        const r = await sendItem(it)
        if (discarded.has(it.id)) { discarded.delete(it.id); await dbDelete(it.id); continue } // deleted while it was being sent: forget it, whatever the answer
        if (!failed(r)) {
          items = items.filter(i => i.id !== it.id)
          await dbDelete(it.id)
          failedRounds = 0
          emit()
          for (const fn of Array.from(sentListeners)) { try { fn(it, r.message) } catch { /* ignore */ } }
        } else if (r.permanent) {
          it.state = 'failed'; it.error = r.error
          await dbPut(it)
          emit()
        } else {
          it.attempts += 1
          held.add(it.scope)
          offline = true
          await dbPut(it)
          emit()
        }
      }
    } while (again)
    if (offline) {
      const wait = retryDelayMs(failedRounds)
      failedRounds += 1
      timer = setTimeout(() => { timer = null; if (lastUser) void flushOutbox(lastUser) }, wait)
    }
  } finally { running = false }
}

/** Test hook: forget everything in memory. */
export function resetOutboxForTests(): void { discarded.clear(); items = []; loaded = null; running = false; again = false; failedRounds = 0; if (timer) clearTimeout(timer); timer = null; lastUser = null; changeListeners.clear(); sentListeners.clear() }
