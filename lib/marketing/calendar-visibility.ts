/**
 * TD Marketing — who sees what on the Calendar (pure; dev job 9aec66fa, Addendum K, rule K.4). Each person sees their own calendar in full and other people's time only as a grey "Busy"; the setter
 * sees nothing of anybody's Google calendar (she works for the seller and only reads calls and call backs). This is the ONE place the rule is written, so no screen decides it on its own, and the
 * server runs every Google item through it before anything reaches a page. No database and no network here.
 */
export type SourceKind = "seller_personal" | "seller_td" | "owner"
export interface GoogleItem { id: string; kind: SourceKind; start: number; end: number; title: string; guests: readonly string[] }
export type Viewer = "owner" | "seller" | "setter"
export type Tone = "td" | "mine" | "busy"
export interface Shown { id: string; kind: SourceKind; start: number; end: number; tone: Tone; title: string; /** whose time a Busy block is, "" when it is the viewer's own */ sub: string; movable: boolean; guests: string[] }

export interface VisibilityContext {
  /** the seller's personal calendar is shared as "free/busy only" (the share check passed); anything else hides the seller's personal Busy time */
  shareOk: boolean
  ownerEmail: string | null
  ownerLabel: string
  sellerLabel: string
}

/** What this viewer sees of one Google item: the item in full, a "Busy" block, or nothing (null). */
export function shownTo(viewer: Viewer, it: GoogleItem, c: VisibilityContext): Shown | null {
  if (viewer === "setter") return null
  const base = { id: it.id, kind: it.kind, start: it.start, end: it.end }
  const busy = (sub: string): Shown => ({ ...base, tone: "busy", title: "Busy", sub, movable: false, guests: [] })
  if (it.kind === "seller_personal") {
    if (!c.shareOk) return null
    return busy(viewer === "owner" ? c.sellerLabel : "")
  }
  if (it.kind === "seller_td") {
    if (viewer === "seller") return { ...base, tone: "td", title: it.title, sub: "", movable: false, guests: [...it.guests] }
    // the owner sees the events he is part of in full; any other event on the seller's work calendar is Busy (the safe default)
    const part = c.ownerEmail !== null && it.guests.some(g => g.toLowerCase() === c.ownerEmail!.toLowerCase())
    return part ? { ...base, tone: "td", title: it.title, sub: "", movable: false, guests: [...it.guests] } : busy(c.sellerLabel)
  }
  // the owner's own Google calendar
  return viewer === "owner"
    ? { ...base, tone: "mine", title: it.title, sub: "", movable: true, guests: [...it.guests] }
    : busy(c.ownerLabel)
}

/** The Google items a viewer may see, in time order. */
export function shownList(viewer: Viewer, items: readonly GoogleItem[], c: VisibilityContext): Shown[] {
  return items.map(i => shownTo(viewer, i, c)).filter((x): x is Shown => x !== null).sort((a, b) => a.start - b.start)
}

/** What the Calendar screen receives for one Google item: serializable (ISO times), with nothing the viewer may not see. */
export interface GoogleBlock { id: string; start: string; end: string; tone: Tone; title: string; sub: string; movable: boolean; guests: string[] }

export const toBlocks = (shown: readonly Shown[]): GoogleBlock[] => shown.map(s => ({ id: s.id, start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString(), tone: s.tone, title: s.title, sub: s.sub, movable: s.movable, guests: s.guests }))
