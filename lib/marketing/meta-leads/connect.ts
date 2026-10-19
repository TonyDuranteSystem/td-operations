/**
 * "Connect Meta" (pure; TD Marketing, dev job 9aec66fa, Slice 1c). Starts from whatever key Antonio has (a PERSONAL Facebook key, or already a
 * Page key), makes the Page's own long-lasting key, checks it belongs to the right Page, and stores it. The Meta calls and the storage are
 * injected so every branch is unit-tested. Every message is plain English; no key is ever put into a message or a result.
 */
import { explainGraphError, type Check, type CheckStatus } from "@/lib/marketing/meta-leads/connection"
import type { Account } from "@/lib/marketing/meta-leads/graph"
import type { SaveInput } from "@/lib/marketing/meta-leads/key-store"

export interface ConnectDeps {
  appId: string | null
  appSecret: string | null
  /** The Pages that run the ads (the Vercel Page-ids setting). */
  pageIds: string[]
  /** A key pasted into the box (preferred), else the one set on Vercel. */
  userKey: string | null
  envKey: string | null
  connectedBy: string
  identity: (key: string) => Promise<{ id: string; name?: string }>
  exchange: (key: string, appId: string, appSecret: string) => Promise<{ accessToken: string; expiresIn: number | null }>
  accounts: (key: string) => Promise<Account[]>
  save: (i: SaveInput) => Promise<string | null>
}

export interface ConnectReport { ok: boolean; steps: Check[]; connectedPages: Array<{ id: string; name: string | null; longLived: boolean }> }

export async function connectMeta(d: ConnectDeps): Promise<ConnectReport> {
  const steps: Check[] = []
  const connectedPages: ConnectReport["connectedPages"] = []
  const add = (key: string, label: string, status: CheckStatus, detail: string) => steps.push({ key, label, status, detail })
  const done = (ok: boolean): ConnectReport => ({ ok, steps, connectedPages })

  if (!d.appSecret) { add("secret", "App secret", "fail", "The Meta app secret is not set on Vercel. It is needed to store the key safely."); return done(false) }
  if (d.pageIds.length === 0) { add("pages", "Page ids", "fail", "No Page ids are set on Vercel yet. Set the id of the Page that runs the ads first."); return done(false) }
  const startKey = d.userKey || d.envKey
  if (!startKey) { add("key", "Starting key", "fail", "There is no key to start from. Paste your Facebook key into the box, or set one on Vercel."); return done(false) }
  add("key", "Starting key", "ok", d.userKey ? "Using the key you pasted." : "Using the key set on Vercel.")

  let me: { id: string; name?: string }
  try { me = await d.identity(startKey) } catch (e) { add("identity", "Meta accepts the key", "fail", explainGraphError(e)); return done(false) }

  // A Page key supplied directly: nothing to convert.
  if (d.pageIds.includes(me.id)) {
    add("identity", "Meta accepts the key", "ok", `It is already the key of the Page "${me.name ?? me.id}".`)
    const err = await d.save({ pageId: me.id, pageName: me.name ?? null, key: startKey, userId: null, userName: null, longLived: false, connectedBy: d.connectedBy })
    if (err) { add("save", "Stored safely", "fail", err); return done(false) }
    add("save", "Stored safely", "ok", "Saved, encrypted, in our database.")
    add("lasting", "How long it lasts", "warn", "This is a Page key you supplied directly. It keeps working as long as Meta accepts it, but we cannot tell how long that is.")
    connectedPages.push({ id: me.id, name: me.name ?? null, longLived: false })
    return done(true)
  }

  add("identity", "Meta accepts the key", "ok", `It is the personal key of "${me.name ?? me.id}". The Page's own key will be made from it.`)

  // Make it long-lasting (about 60 days) so the Page key made from it does not expire on a clock.
  let workKey = startKey
  let longLived = false
  if (d.appId) {
    try {
      const x = await d.exchange(startKey, d.appId, d.appSecret)
      workKey = x.accessToken
      longLived = true
      add("long", "Made long-lasting", "ok", "Meta extended the key. A Page key made from it does not expire on a clock.")
    } catch (e) {
      add("long", "Made long-lasting", "warn", `Meta would not extend the key (${explainGraphError(e)}). I will still try, but a key made this way may stop working within hours.`)
    }
  } else {
    add("long", "Made long-lasting", "warn", "The Meta app id is not set on Vercel, so the key could not be extended. A key made this way may stop working within hours.")
  }

  let accounts: Account[]
  try { accounts = await d.accounts(workKey) } catch (e) { add("accounts", "Find the Page's own key", "fail", explainGraphError(e)); return done(false) }

  let allOk = true
  for (const pageId of d.pageIds) {
    const page = accounts.find(a => a.id === pageId)
    if (!page || !page.access_token) {
      const seen = accounts.map(a => a.name ?? a.id).slice(0, 8)
      add(`page_${pageId}`, `Page ${pageId}`, "fail", `Your key does not manage this Page${seen.length ? ` (it manages: ${seen.join(", ")})` : " (it manages no Pages)"}. Generate the key again in Meta and choose the right Page when Facebook asks.`)
      allOk = false
      continue
    }
    // Make sure the key we are about to store really is this Page's.
    try {
      const who = await d.identity(page.access_token)
      if (who.id !== pageId) { add(`page_${pageId}`, `Page ${pageId}`, "fail", `Meta says the key belongs to "${who.name ?? who.id}", not to this Page. Nothing was stored.`); allOk = false; continue }
    } catch (e) { add(`page_${pageId}`, `Page ${pageId}`, "fail", `The Page's key was rejected by Meta: ${explainGraphError(e)}`); allOk = false; continue }
    const err = await d.save({ pageId, pageName: page.name ?? null, key: page.access_token, userId: me.id, userName: me.name ?? null, longLived, connectedBy: d.connectedBy })
    if (err) { add(`page_${pageId}`, `Page ${page.name ?? pageId}`, "fail", err); allOk = false; continue }
    add(`page_${pageId}`, `Page ${page.name ?? pageId}`, longLived ? "ok" : "warn", longLived
      ? `Connected. The Page's own key is stored, encrypted. It does not expire on a clock; it stops only if ${me.name ?? "this person"} changes their Facebook password or loses their role on the Page.`
      : "Connected, but the key was not extended, so it may stop working within hours. Press Connect again with a fresh key, or set the app id on Vercel.")
    connectedPages.push({ id: pageId, name: page.name ?? null, longLived })
  }
  return done(allOk && connectedPages.length > 0)
}
