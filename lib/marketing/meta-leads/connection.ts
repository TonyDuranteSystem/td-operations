/**
 * "Is Meta connected?" — the checks behind Antonio's button (pure; TD Marketing, dev job 9aec66fa). The Meta calls are injected so
 * every branch is unit-tested. Every result is in plain English; secrets are only ever reported as set / not set, never their value.
 */
import { GraphError, type SubscribedApp } from "@/lib/marketing/meta-leads/graph"

export type CheckStatus = "ok" | "warn" | "fail" | "skip"
export interface Check { key: string; label: string; status: CheckStatus; detail: string }
export interface ConnectionReport { ok: boolean; checks: Check[] }

export interface KeySource {
  kind: "database" | "vercel" | "unreadable" | "none"
  /** For the database: "Tony Durante LLC, connected 19 Oct, long-lasting". */
  note?: string
}

export interface ConnectionEnv {
  appSecret: boolean
  verifyToken: boolean
  /** Is ANY usable Page key available (stored, or on Vercel)? */
  pageToken: boolean
  /** Where it comes from. Unset = just say it is set. */
  keyFrom?: KeySource
  pageIds: string[]
  /** Our Meta app's id (public, not a secret). Unset = we cannot tell which listed app is ours. */
  appId: string | null
}

export interface ConnectionDeps {
  env: ConnectionEnv
  identity: () => Promise<{ id: string; name?: string }>
  subscribedApps: (pageId: string) => Promise<SubscribedApp[]>
  forms: (pageId: string) => Promise<Array<{ id: string; name?: string; status?: string }>>
}

/** Meta's error, said so a person can act on it. */
export function explainGraphError(e: unknown): string {
  if (e instanceof GraphError) {
    if (e.status === null) return /not set/i.test(e.message) ? "The Page access key is not set on the server yet." : "The request was not sent."
    if (e.code === 190) return "Meta says the access key is invalid or has expired. Create a new Page access key and replace it on Vercel."
    if (e.code === 10 || e.code === 200 || e.code === 299 || e.status === 403) return `The access key does not have the permission this needs. Meta says: ${e.message.replace(/^Graph \d+:\s*/, "")}`
    if (e.code === 4 || e.code === 17 || e.code === 32 || e.code === 613) return "Meta is limiting how often we may ask. Try again in a few minutes."
    if (e.code === 100 || e.status === 404) return `Meta could not find that, or the request is not allowed for this key. Meta says: ${e.message.replace(/^Graph \d+:\s*/, "")}`
    if (e.status >= 500) return "Meta had a temporary problem. Try again in a minute."
    return e.message
  }
  if (e instanceof Error && /abort|timeout/i.test(`${e.name} ${e.message}`)) return "Meta did not answer in time. Try again."
  return e instanceof Error ? e.message : String(e)
}

const has = (apps: SubscribedApp[], appId: string | null) => (appId ? apps.find(a => a.id === appId) : undefined)

export async function checkMetaConnection(d: ConnectionDeps): Promise<ConnectionReport> {
  const checks: Check[] = []
  const add = (key: string, label: string, status: CheckStatus, detail: string) => checks.push({ key, label, status, detail })

  add("app_secret", "App secret", d.env.appSecret ? "ok" : "fail", d.env.appSecret ? "Set." : "Not set on Vercel. Without it every notification from Meta is refused.")
  add("verify_token", "Webhook verify password", d.env.verifyToken ? "ok" : "fail", d.env.verifyToken ? "Set." : "Not set on Vercel. Meta's handshake will be refused.")
  const kf = d.env.keyFrom
  if (kf?.kind === "database") add("page_token", "Page access key", "ok", `Stored safely in our database${kf.note ? ` (${kf.note})` : ""}.`)
  else if (kf?.kind === "unreadable") add("page_token", "Page access key", d.env.pageToken ? "warn" : "fail", `A key is stored in our database but can no longer be read (the Meta app secret was changed). ${d.env.pageToken ? "The key set on Vercel is being used instead. " : ""}Press "Connect Meta" again.`)
  else add("page_token", "Page access key", d.env.pageToken ? "ok" : "fail", d.env.pageToken ? "Set on Vercel." : "Not set. Press \"Connect Meta\" on this page, or set a key on Vercel. We cannot read any lead without it.")
  add("page_ids", "Page ids", d.env.pageIds.length ? "ok" : "fail", d.env.pageIds.length ? `${d.env.pageIds.length} Page${d.env.pageIds.length === 1 ? "" : "s"} configured.` : "Not set on Vercel. The safety re-read has no Page to look at.")
  add("app_id", "Our Meta app id", d.env.appId ? "ok" : "warn", d.env.appId ? "Set." : "Not set. The check cannot tell which installed app is ours, so it cannot say whether the Page is subscribed.")

  if (!d.env.pageToken) {
    add("token", "Access key accepted by Meta", "skip", "Skipped: no access key is set.")
    return { ok: false, checks }
  }

  let identityId: string | null = null
  try {
    const me = await d.identity()
    identityId = me.id
    if (d.env.pageIds.length === 0 || d.env.pageIds.includes(me.id)) add("token", "Access key accepted by Meta", "ok", `Meta accepts the key. It belongs to the Page "${me.name ?? me.id}".`)
    else add("token", "Access key accepted by Meta", "warn", `Meta accepts the key, but it belongs to "${me.name ?? me.id}" (${me.id}), which is not one of the configured Pages. It must be a Page access key for the Page that runs the ads.`)
  } catch (e) {
    add("token", "Access key accepted by Meta", "fail", explainGraphError(e))
    return { ok: false, checks }
  }

  for (const pageId of d.env.pageIds) {
    const tag = d.env.pageIds.length > 1 ? ` (Page ${pageId})` : ""
    try {
      const apps = await d.subscribedApps(pageId)
      const ours = has(apps, d.env.appId)
      if (ours && (ours.subscribed_fields ?? []).includes("leadgen")) add(`subscribed_${pageId}`, `Page sends us new leads${tag}`, "ok", "Subscribed: Meta will notify us the moment someone fills in the form.")
      else if (ours) add(`subscribed_${pageId}`, `Page sends us new leads${tag}`, "fail", "Our app is installed on the Page but is not set to receive new leads. Use the Subscribe button.")
      else if (d.env.appId) add(`subscribed_${pageId}`, `Page sends us new leads${tag}`, "fail", apps.length ? `Not subscribed. The Page has ${apps.length} other app${apps.length === 1 ? "" : "s"} installed, not ours. Use the Subscribe button.` : "Not subscribed yet. Use the Subscribe button.")
      else add(`subscribed_${pageId}`, `Page sends us new leads${tag}`, "warn", apps.length ? `The Page has ${apps.length} app${apps.length === 1 ? "" : "s"} installed (${apps.map(a => a.name ?? a.id).join(", ")}); set our app id to see whether ours is one of them.` : "No app is installed on the Page yet. Use the Subscribe button.")
    } catch (e) {
      add(`subscribed_${pageId}`, `Page sends us new leads${tag}`, "fail", explainGraphError(e))
    }
    try {
      const forms = await d.forms(pageId)
      if (forms.length) add(`forms_${pageId}`, `Lead forms we can read${tag}`, "ok", `${forms.length} form${forms.length === 1 ? "" : "s"}: ${forms.slice(0, 5).map(f => f.name ?? f.id).join(", ")}${forms.length > 5 ? ", ..." : ""}.`)
      else add(`forms_${pageId}`, `Lead forms we can read${tag}`, "warn", "The key can reach the Page but sees no lead forms. Either there are none, or the key's owner does not have access to the Page's leads.")
    } catch (e) {
      add(`forms_${pageId}`, `Lead forms we can read${tag}`, "fail", explainGraphError(e))
    }
  }
  void identityId
  return { ok: checks.every(c => c.status === "ok" || c.status === "skip" || c.key === "app_id"), checks }
}

export interface SubscribeResult { pageId: string; ok: boolean; detail: string }

/** Subscribe each configured Page to our app's lead notifications. One Page failing never stops the others. */
export async function subscribePages(pageIds: string[], subscribe: (pageId: string) => Promise<boolean>): Promise<SubscribeResult[]> {
  const out: SubscribeResult[] = []
  for (const pageId of pageIds) {
    try {
      const ok = await subscribe(pageId)
      out.push({ pageId, ok, detail: ok ? "Subscribed. New leads from this Page will now reach us." : "Meta answered but did not confirm the subscription." })
    } catch (e) {
      out.push({ pageId, ok: false, detail: explainGraphError(e) })
    }
  }
  return out
}
