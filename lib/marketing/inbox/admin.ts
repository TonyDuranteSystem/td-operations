/**
 * TD Marketing — Antonio's side of the Inbox (server; dev job 9aec66fa): add an address, change who may open it, remove it. Only the strict-admin route calls these. Adding an address is a two-step
 * thing: first the system CHECKS it can really open it (and tells him who it would default to), then he saves with the people he ticked; the save checks everything AGAIN from scratch (the check
 * the browser saw is never trusted). Every change is kept in the settings history under his email.
 */
import { getMailDriver } from "@/lib/marketing/inbox/driver"
import { defaultPeople, checkNewAddress, type InboxMailbox } from "@/lib/marketing/inbox/mailboxes"
import { teamMailboxes } from "@/lib/marketing/inbox/access"
import { listMembers } from "@/lib/marketing/members"
import { setMarketingSetting } from "@/lib/marketing/settings"

type Res<T> = { ok: true; data: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

async function activeMembers(teamId: string) {
  return (await listMembers(teamId)).filter(m => m.status === "active" || m.status === "paused")
}

/** Step 1: can the system open this address, and who would see it by default. Writes nothing. */
export async function checkMailbox(teamId: string, raw: unknown): Promise<Res<{ address: string; people: string[] }>> {
  const list = await teamMailboxes(teamId)
  const c = checkNewAddress(raw, list.map(b => b.address))
  if (c.ok === false) return fail(c.error)
  const ping = await (await getMailDriver()).ping(c.address)
  if (ping.ok === false) return fail(ping.error)
  return { ok: true, data: { address: c.address, people: defaultPeople(c.address, await activeMembers(teamId)) } }
}

/** One line of the signature (name / title / phone): plain text, no line breaks, at most 80 characters. */
const cleanLine = (v: unknown): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "")
export interface SignatureInput { name?: unknown; title?: unknown; phone?: unknown }

async function cleanPeople(teamId: string, v: unknown): Promise<Res<string[]>> {
  if (v === undefined || v === null) return { ok: true, data: [] }
  if (!Array.isArray(v) || v.some(x => typeof x !== "string")) return fail("Choose people from the team.")
  const ids = new Set((await activeMembers(teamId)).map(m => m.user_id))
  const unique = Array.from(new Set(v as string[]))
  if (unique.some(id => !ids.has(id))) return fail("Choose people from the team.")
  return { ok: true, data: unique }
}

/** Step 2: save a new address (everything is checked again here). */
export async function addMailbox(input: { teamId: string; address: unknown; people: unknown; signature?: SignatureInput; actor: string }): Promise<Res<InboxMailbox[]>> {
  const checked = await checkMailbox(input.teamId, input.address)
  if (checked.ok === false) return checked
  const people = await cleanPeople(input.teamId, input.people ?? checked.data.people)
  if (people.ok === false) return people
  const next: InboxMailbox[] = [...(await teamMailboxes(input.teamId)), { address: checked.data.address, people: people.data, signature_name: cleanLine(input.signature?.name), signature_title: cleanLine(input.signature?.title), signature_phone: cleanLine(input.signature?.phone) }]
  const w = await setMarketingSetting({ key: "inbox_mailboxes", value: next, teamId: input.teamId, actor: input.actor })
  return w.ok === false ? fail(w.error) : { ok: true, data: next }
}

export async function updateMailbox(input: { teamId: string; address: unknown; people?: unknown; signature?: SignatureInput; actor: string }): Promise<Res<InboxMailbox[]>> {
  const list = await teamMailboxes(input.teamId)
  const i = list.findIndex(b => b.address === input.address)
  if (i < 0) return fail("That address is not in the list.")
  const next = list.map(b => ({ ...b }))
  if (input.people !== undefined) {
    const people = await cleanPeople(input.teamId, input.people)
    if (people.ok === false) return people
    next[i].people = people.data
  }
  if (input.signature !== undefined) {
    next[i].signature_name = cleanLine(input.signature.name)
    next[i].signature_title = cleanLine(input.signature.title)
    next[i].signature_phone = cleanLine(input.signature.phone)
  }
  const w = await setMarketingSetting({ key: "inbox_mailboxes", value: next, teamId: input.teamId, actor: input.actor })
  return w.ok === false ? fail(w.error) : { ok: true, data: next }
}

export async function removeMailbox(input: { teamId: string; address: unknown; actor: string }): Promise<Res<InboxMailbox[]>> {
  const list = await teamMailboxes(input.teamId)
  if (!list.some(b => b.address === input.address)) return fail("That address is not in the list.")
  const next = list.filter(b => b.address !== input.address)
  const w = await setMarketingSetting({ key: "inbox_mailboxes", value: next, teamId: input.teamId, actor: input.actor })
  return w.ok === false ? fail(w.error) : { ok: true, data: next }
}
