/**
 * TD Marketing — the lead board (pure; dev job 9aec66fa, Addendum G of the master plan, approved by Antonio 2026-10-23).
 * Two roles see the same leads in different columns: the SETTER (qualifies leads on WhatsApp) and the SELLER (takes the call and sells). The column a lead sits in
 * comes from its stage, so there is no second copy of the state to keep in step. No database here.
 */
import type { TFn } from "@/lib/marketing/i18n"

export type BoardRole = "setter" | "seller"
export type BoardView = "pipeline" | "cards" | "list"
export const BOARD_VIEWS: readonly BoardView[] = ["pipeline", "cards", "list"]
export const parseBoardView = (v: unknown): BoardView => (BOARD_VIEWS as readonly string[]).includes(v as string) ? (v as BoardView) : "pipeline"

/** A person who sells: creates payment links, hosts the calls or picks leads (the seller bundle has no money permission, so the money permission alone is not the test). */
const sellerish = (p: readonly string[]) => p.includes("payment_links.create") || p.includes("calls.host") || p.includes("leads.pick")
/** A person who qualifies leads on WhatsApp (the setter bundle). */
const setterish = (p: readonly string[]) => p.includes("leads.worklist")

/** The boards this person may use: the seller's, the setter's, or both (the team owner holds every permission). Never empty. */
export function availableBoardRoles(permissions: readonly string[]): BoardRole[] {
  const out: BoardRole[] = []
  if (sellerish(permissions)) out.push("seller")
  if (setterish(permissions)) out.push("setter")
  return out.length ? out : ["setter"]
}

/** The board a person sees: the one he asked for when he may use it (an owner can switch), else the seller's for a seller, else the setter's. */
export function resolveBoardRole(permissions: readonly string[], requested?: unknown): BoardRole {
  const roles = availableBoardRoles(permissions)
  return roles.find(r => r === requested) ?? roles[0]
}

/** The default board for these permissions. */
export const boardRole = (permissions: readonly string[]): BoardRole => resolveBoardRole(permissions)

export interface BoardColumn {
  key: string
  /** English text; the screen passes it through t() */
  label: string
  /** the lead stages (pipeline_stages keys) that sit in this column */
  stages: readonly string[]
}

const SETTER_COLUMNS: readonly BoardColumn[] = [
  { key: "to_contact", label: "To contact", stages: ["new"] },
  { key: "tried", label: "Tried, no answer", stages: ["contacted"] },
  { key: "in_target", label: "In target", stages: ["qualified"] },
  { key: "out", label: "Out of target", stages: ["not_in_target"] },
]
// Rocco's board (the flow of 3 Nov 2026): booking the free call IS the hand-over, so a lead appears in "Calls prenotate" the moment the setter books it and leaves the setter's board (she keeps the chat). When the call time has
// passed (or the lead has no call time) it moves to "After the call", where Rocco says whether the call happened and chooses a result. There is no "Interested lead" and no "Contacted" step any more. A new chat message does NOT
// move a card (Antonio, 28 Oct 2026): the card stays in its stage, blinks for a few seconds and carries a "New message" tag until the chat is read.
const SELLER_COLUMNS: readonly BoardColumn[] = [
  { key: "booked", label: "Calls prenotate", stages: ["booked", "showed"] },
  { key: "after_call", label: "After the call", stages: [] },
  { key: "closed", label: "Link sent", stages: ["closed"] },
  { key: "out", label: "Not in target", stages: ["not_in_target"] },
  { key: "not_ready", label: "Not ready now", stages: ["not_ready"] },
  { key: "paid", label: "Paid", stages: ["paid_call", "upsell_won"] },
  { key: "booking_link", label: "Booking link sent", stages: ["booking_link"] },
  { key: "upsell", label: "Upsell", stages: ["upsell"] },
  { key: "waiting", label: "Waiting", stages: ["waiting"] },
  { key: "archived", label: "Archived", stages: ["archived"] },
]

export const columnsFor = (role: BoardRole): readonly BoardColumn[] => (role === "seller" ? SELLER_COLUMNS : SETTER_COLUMNS)

/** The column a stage sits in for this role, or null (a lead "not in target", or at a stage the board does not show). */
export function columnOf(role: BoardRole, stage: string): string | null {
  return columnsFor(role).find(c => c.stages.includes(stage))?.key ?? null
}

/** The column a CARD sits in. For the seller a booked lead whose call time has passed (or that has no call time) sits in "After the call" instead of "Calls prenotate". A lead the setter turned down before it ever reached Rocco
 *  (no call booked) is not on his board; an in-target lead with no call is still the setter's. An unread chat message never changes the column (it is shown on the card itself). */
export function columnOfCard(role: BoardRole, card: Pick<BoardCard, "stage" | "callCheck"> & { apptAt?: string | null }): string | null {
  const key = columnOf(role, card.stage)
  if (role !== "seller") return key
  if (key === "booked" && card.callCheck) return "after_call"
  if (card.stage === "not_in_target" && !card.apptAt) return null
  return key
}

/** How long after its start a free call counts as over (the call is about 15 minutes; this leaves room for it to run a little long). */
export const CALL_OVER_GRACE_MS = 30 * 60 * 1000
/** A booked lead needs the seller's answer about its call when the call time is past, or when no call time is recorded. */
export function needsCallAnswer(stage: string, apptAt: string | null, now: Date): boolean {
  if (stage !== "booked" && stage !== "showed") return false
  if (!apptAt) return true
  const t = Date.parse(apptAt)
  return Number.isNaN(t) || t + CALL_OVER_GRACE_MS < now.getTime()
}

export interface BoardCard {
  id: string
  name: string
  stage: string
  stageLabel: string
  phone: string | null
  /** when the form was filled in, already formatted */
  filledIn: string
  /** the next call booked with the seller (ISO) */
  apptAt: string | null
  /** when the form came in (ms), for the order inside a column */
  arrivedMs: number
  /** short facts: WhatsApp ✓, No answer ×2, Call 27 Oct 11:00 */
  chips: Array<{ key: string; text: string; tone: "ok" | "warn" | "info" }>
  /** who has the lead, as a word ("With the setter", "With you", …) */
  withText: string
  /** the setter's last written line; only given to people who may read notes */
  note: string | null
  ad: string | null
  existingClient: boolean
  /** my unread chat messages in this lead */
  unread: number
  /** who wrote the newest message I have not read: the setter (green on the card) or Antonio / anyone else (red); null when nothing is unread */
  incomingFrom?: "setter" | "owner" | null
  /** a booked lead whose free call is over (its time has passed) or that has no call time: the seller says whether it happened */
  callCheck: boolean
  /** what the seller answered about the call: it happened, it did not, or nothing yet */
  callAnswer: "happened" | "missed" | null
}

/** The cards of one column in the order people work them: calls by their time (soonest first), everything else newest first. */
export function cardsInColumn(role: BoardRole, columnKey: string, cards: readonly BoardCard[]): BoardCard[] {
  const col = columnsFor(role).find(c => c.key === columnKey)
  if (!col) return []
  const mine = cards.filter(c => columnOfCard(role, c) === columnKey)
  if (columnKey === "booked") return mine.sort((a, b) => (a.apptAt ?? "9").localeCompare(b.apptAt ?? "9") || b.arrivedMs - a.arrivedMs)
  if (columnKey === "after_call") return mine.sort((a, b) => (a.apptAt ?? "").localeCompare(b.apptAt ?? "") || b.arrivedMs - a.arrivedMs) // the longest-waiting call first
  return mine.sort((a, b) => b.arrivedMs - a.arrivedMs)
}

/** Every card the board shows, in column order (the Cards view). */
export function boardCards(role: BoardRole, cards: readonly BoardCard[]): BoardCard[] {
  return columnsFor(role).flatMap(c => cardsInColumn(role, c.key, cards))
}

/** How many leads the board leaves out because they sit at no column (for the "not shown" note). The setter's booked leads are not counted: booking the call handed them to Rocco, they are not missing from her board. */
export function hiddenCount(role: BoardRole, cards: readonly BoardCard[]): number {
  return cards.filter(c => columnOfCard(role, c) === null && !(role === "setter" && (c.stage === "booked" || c.stage === "showed"))).length
}

/** The column heading with its count: "In target · 3". */
export function columnTitle(col: BoardColumn, count: number, t: TFn): string {
  return `${t(col.label)} · ${count}`
}
