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
  // what she passes to Rocco; it leaves her board when he marks the lead Contacted
  { key: "booked", label: "Interested lead", stages: ["booked", "showed"] },
  { key: "out", label: "Out of target", stages: ["not_in_target"] },
]
// Rocco's board (the call of 27 Oct 2026): Interested lead, Contacted, Link sent, Not in target, Not ready now, Paid, Booking link sent, Upsell, Waiting, Archived. A lead the setter passed on but
// nobody has booked yet still shows under "Interested lead" so it never disappears. A new chat message does NOT move a card (Antonio, 28 Oct 2026, reversing the "Incoming messages" column of 27 Oct:
// "when a message is received the card does not have to change stage"): the card stays in its stage, blinks for a few seconds and carries a "New message" tag until the chat is read.
const SELLER_COLUMNS: readonly BoardColumn[] = [
  { key: "booked", label: "Interested lead", stages: ["booked", "showed", "qualified"] },
  { key: "contacted", label: "Contacted", stages: ["seller_contacted"] },
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

/** The column a CARD sits in. For the seller an in-target lead appears only once the setter has passed it on; until then it is the setter's. Likewise a turned-down lead only if it reached him.
 *  An unread chat message never changes the column (it is shown on the card itself). */
export function columnOfCard(role: BoardRole, card: Pick<BoardCard, "stage" | "handedOver"> & { apptAt?: string | null }): string | null {
  const key = columnOf(role, card.stage)
  if (role !== "seller") return key
  if (card.stage === "qualified" && !card.handedOver) return null
  // a lead the setter turned down before it ever reached Rocco (not passed on, no call booked) is not on his board
  if (card.stage === "not_in_target" && !card.handedOver && !card.apptAt) return null
  return key
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
  /** who picked the lead, as a word ("Not picked", "Picked by you", …) */
  pickedText: string
  /** the setter's last written line; only given to people who may read notes */
  note: string | null
  ad: string | null
  existingClient: boolean
  /** my unread chat messages in this lead */
  unread: number
  /** who wrote the newest message I have not read: the setter (green on the card) or Antonio / anyone else (red); null when nothing is unread */
  incomingFrom?: "setter" | "owner" | null
  /** the setter passed this lead to the seller */
  handedOver: boolean
}

/** The cards of one column in the order people work them: calls by their time (soonest first), everything else newest first. */
export function cardsInColumn(role: BoardRole, columnKey: string, cards: readonly BoardCard[]): BoardCard[] {
  const col = columnsFor(role).find(c => c.key === columnKey)
  if (!col) return []
  const mine = cards.filter(c => columnOfCard(role, c) === columnKey)
  if (columnKey === "booked") return mine.sort((a, b) => (a.apptAt ?? "9").localeCompare(b.apptAt ?? "9") || b.arrivedMs - a.arrivedMs)
  return mine.sort((a, b) => b.arrivedMs - a.arrivedMs)
}

/** Every card the board shows, in column order (the Cards view). */
export function boardCards(role: BoardRole, cards: readonly BoardCard[]): BoardCard[] {
  return columnsFor(role).flatMap(c => cardsInColumn(role, c.key, cards))
}

/** How many leads the board leaves out because they sit at no column (for the "not shown" note). */
export function hiddenCount(role: BoardRole, cards: readonly BoardCard[]): number {
  return cards.filter(c => columnOfCard(role, c) === null).length
}

/** The column heading with its count: "In target · 3". */
export function columnTitle(col: BoardColumn, count: number, t: TFn): string {
  return `${t(col.label)} · ${count}`
}
