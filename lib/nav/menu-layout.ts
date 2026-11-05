/**
 * The left menu's LAYOUT (dev job 45aa5872, Antonio 2026-11-04: "create a new tab from the menu, move pages in and out,
 * reorder them easily"): which pages sit in the main list and which sit inside a group (TD Social, Accounting, Network,
 * or any group the person makes).
 *
 * Pure on purpose — no React, no browser, no database — so every rule below is unit-tested without a screen.
 *
 * THE RULES THAT MATTER
 * - A layout is FLEXIBLE DATA saved per login; the list of real pages is code (`defaultNavigation` in sidebar.tsx). A layout can
 *   only point at pages that exist; anything else in it is dropped on load.
 * - A layout always holds EVERY page exactly once — including pages this person may not see. Who may see a page is decided
 *   AFTER the layout, per page, never by the group it sits in, so a saved layout can never unlock anything.
 * - A page added to the code later never gets lost: it is put back (in its standard group if the person still has that group,
 *   otherwise at the end of the main list).
 * - Groups are one level deep (a group holds pages, never groups).
 * - Deleting a group never deletes pages: they go back to the main list in the group's place.
 * - At display time a group whose pages are all hidden from this person disappears; a group that permissions cut down to exactly
 *   one page they can see is shown as that plain page (Luca's "Accounting" is just Finance). A group the person made with one
 *   page on purpose stays a group — it is their own structure, and it must not vanish into a plain row.
 */

export interface PageRow { type: 'page'; id: string }
export interface GroupRow { type: 'group'; id: string; name: string; children: string[] }
export type MenuRow = PageRow | GroupRow
export interface MenuLayout { v: 1; rows: MenuRow[] }

/** Where a page lives: the main list, or the id of a group. */
export type Container = 'root' | string

export const MAX_GROUPS = 12
export const GROUP_NAME_MAX = 24
export const GROUP_ID_PREFIX = 'g-'
/** Biggest saved layout we accept (a normal one is well under 2 KB). */
export const MAX_LAYOUT_BYTES = 16 * 1024

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/

export function isGroupId(id: string): boolean {
  return id.startsWith(GROUP_ID_PREFIX)
}

/** The groups a person starts with (Antonio's own list, 2026-11-04). Members are page ids; a missing one is skipped. */
export const STANDARD_GROUPS: ReadonlyArray<{ id: string; name: string; children: readonly string[] }> = [
  { id: 'g-social', name: 'TD Social', children: ['td-talk', 'inbox', 'marketing-chat', 'whatsapp', 'team-chat', 'portal-chats'] },
  { id: 'g-accounting', name: 'Accounting', children: ['finance', 'owner'] },
  { id: 'g-network', name: 'Network', children: ['leads', 'contacts', 'accounts'] },
]

const page = (id: string): PageRow => ({ type: 'page', id })

/** The standard layout: pages in `pageIds` order, each standard group standing where its first member stood. */
export function standardLayout(pageIds: readonly string[]): MenuLayout {
  const known = new Set(pageIds)
  const groups = STANDARD_GROUPS.map(g => ({ ...g, children: g.children.filter(c => known.has(c)) })).filter(g => g.children.length > 0)
  const inGroup = new Map<string, string>() // page id -> group id
  for (const g of groups) for (const c of g.children) inGroup.set(c, g.id)
  const placed = new Set<string>()
  const rows: MenuRow[] = []
  for (const id of pageIds) {
    const gid = inGroup.get(id)
    if (!gid) { rows.push(page(id)); continue }
    if (placed.has(gid)) continue
    placed.add(gid)
    const g = groups.find(x => x.id === gid)!
    rows.push({ type: 'group', id: g.id, name: g.name, children: [...g.children] })
  }
  return { v: 1, rows }
}

/**
 * First time on the new menu: keep the person's OLD order for the rows that are not in a group. Each group stands where its
 * earliest member stood in the old list. Pages the old list never knew keep their standard place.
 */
export function layoutFromLegacyOrder(legacy: readonly string[], pageIds: readonly string[]): MenuLayout {
  const base = standardLayout(pageIds)
  const rank = new Map<string, number>()
  legacy.forEach((id, i) => { if (!rank.has(id)) rank.set(id, i) })
  const rowRank = (r: MenuRow): number => {
    if (r.type === 'page') return rank.get(r.id) ?? Number.POSITIVE_INFINITY
    return Math.min(...r.children.map(c => rank.get(c) ?? Number.POSITIVE_INFINITY))
  }
  const indexed = base.rows.map((r, i) => ({ r, i, k: rowRank(r) }))
  // Rows the old list never knew stay where the standard layout put them (relative to their neighbours): sort only the known ones.
  const knownSlots = indexed.filter(x => Number.isFinite(x.k))
  const sortedKnown = [...knownSlots].sort((a, b) => a.k - b.k || a.i - b.i)
  const out: MenuRow[] = indexed.map(x => x.r)
  knownSlots.forEach((slot, n) => { out[slot.i] = sortedKnown[n].r })
  return { v: 1, rows: out }
}

/* ───────────────────────────── reading a saved layout ───────────────────────────── */

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX).trim()
  return name.length > 0 ? name : null
}

/**
 * Shape check only (no knowledge of which pages exist). Returns null for anything that is not a layout, so the caller falls back
 * to the standard one. Used on the server before saving and in the browser before using what was saved.
 */
export function parseLayout(raw: unknown): MenuLayout | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as { v?: unknown; rows?: unknown }
  if (o.v !== 1 || !Array.isArray(o.rows)) return null
  if (o.rows.length > 400) return null
  const rows: MenuRow[] = []
  for (const r of o.rows) {
    if (!r || typeof r !== 'object') return null
    const row = r as { type?: unknown; id?: unknown; name?: unknown; children?: unknown }
    if (typeof row.id !== 'string' || !ID_RE.test(row.id)) return null
    if (row.type === 'page') {
      if (isGroupId(row.id)) return null
      rows.push(page(row.id))
    } else if (row.type === 'group') {
      if (!isGroupId(row.id)) return null
      const name = cleanName(row.name)
      if (!name || !Array.isArray(row.children) || row.children.length > 400) return null
      const children: string[] = []
      for (const c of row.children) {
        if (typeof c !== 'string' || !ID_RE.test(c) || isGroupId(c)) return null
        children.push(c)
      }
      rows.push({ type: 'group', id: row.id, name, children })
    } else {
      return null
    }
  }
  const layout: MenuLayout = { v: 1, rows }
  return JSON.stringify(layout).length <= MAX_LAYOUT_BYTES ? layout : null
}

/**
 * Make a (shape-valid) layout agree with the pages that exist now: drop unknown pages and repeats, cap the groups, and bring
 * back any page the layout is missing. The result holds every page in `pageIds` exactly once.
 */
export function reconcileLayout(layout: MenuLayout, pageIds: readonly string[]): MenuLayout {
  const known = new Set(pageIds)
  const seen = new Set<string>()
  const seenGroups = new Set<string>()
  const rows: MenuRow[] = []
  let groupCount = 0
  for (const r of layout.rows) {
    if (r.type === 'page') {
      if (known.has(r.id) && !seen.has(r.id)) { seen.add(r.id); rows.push(page(r.id)) }
      continue
    }
    const children = r.children.filter(c => known.has(c) && !seen.has(c))
    if (seenGroups.has(r.id)) { for (const c of children) { seen.add(c); rows.push(page(c)) } continue }
    seenGroups.add(r.id)
    if (groupCount >= MAX_GROUPS) { for (const c of children) { seen.add(c); rows.push(page(c)) } continue }
    groupCount++
    for (const c of children) seen.add(c)
    rows.push({ type: 'group', id: r.id, name: r.name, children })
  }
  // Pages the layout does not know: into their standard group if the person still has it, else the end of the main list.
  const standardHome = new Map<string, string>()
  for (const g of STANDARD_GROUPS) for (const c of g.children) standardHome.set(c, g.id)
  for (const id of pageIds) {
    if (seen.has(id)) continue
    seen.add(id)
    const home = standardHome.get(id)
    const group = home ? rows.find((x): x is GroupRow => x.type === 'group' && x.id === home) : undefined
    if (group) group.children.push(id)
    else rows.push(page(id))
  }
  return { v: 1, rows }
}

/** What to show for a saved value: the saved layout made current, or the standard one. */
export function resolveLayout(saved: unknown, pageIds: readonly string[]): MenuLayout {
  const parsed = parseLayout(saved)
  return parsed ? reconcileLayout(parsed, pageIds) : standardLayout(pageIds)
}

/* ───────────────────────────── showing it ───────────────────────────── */

export interface ShownGroup { type: 'group'; id: string; name: string; children: string[]; empty: boolean }
export type ShownRow = PageRow | ShownGroup

/**
 * The rows this person actually sees. `isVisible` is the per-page permission test (admin-only, owner-only, feature switch).
 * `collapseSingles` (normal menu) turns a group that is down to exactly one visible page — because the person may not see its other
 * pages — into that plain page; a group that simply holds one page stays a group. The editor passes false so every group stays
 * where it can be edited.
 */
export function visibleRows(layout: MenuLayout, isVisible: (id: string) => boolean, collapseSingles: boolean): ShownRow[] {
  const out: ShownRow[] = []
  for (const r of layout.rows) {
    if (r.type === 'page') { if (isVisible(r.id)) out.push(r); continue }
    const shown = r.children.filter(isVisible)
    if (r.children.length > 0 && shown.length === 0) continue // everything in it is hidden from this person
    if (collapseSingles && shown.length === 1 && r.children.length > shown.length) { out.push(page(shown[0])); continue }
    out.push({ type: 'group', id: r.id, name: r.name, children: shown, empty: shown.length === 0 })
  }
  return out
}

/** Every visible page, in the order the menu shows them (groups flattened). For the "Open in a window" list. */
export function flattenVisible(layout: MenuLayout, isVisible: (id: string) => boolean): string[] {
  const ids: string[] = []
  for (const r of layout.rows) {
    if (r.type === 'page') { if (isVisible(r.id)) ids.push(r.id) } else for (const c of r.children) if (isVisible(c)) ids.push(c)
  }
  return ids
}

/* ───────────────────────────── editing it ───────────────────────────── */

export function containerOf(layout: MenuLayout, pageId: string): Container | null {
  for (const r of layout.rows) {
    if (r.type === 'page') { if (r.id === pageId) return 'root' } else if (r.children.includes(pageId)) return r.id
  }
  return null
}

function without(layout: MenuLayout, pageId: string): MenuRow[] {
  return layout.rows
    .filter(r => !(r.type === 'page' && r.id === pageId))
    .map(r => (r.type === 'group' && r.children.includes(pageId) ? { ...r, children: r.children.filter(c => c !== pageId) } : r))
}

export interface Place { before?: string; after?: string }

/** Move a page into `to` ('root' or a group id): before/after a neighbour (any row id in that container), else at the end. */
export function movePage(layout: MenuLayout, pageId: string, to: Container, place: Place = {}): MenuLayout {
  if (isGroupId(pageId) || containerOf(layout, pageId) === null) return layout
  if (to !== 'root' && !layout.rows.some(r => r.type === 'group' && r.id === to)) return layout
  const rows = without(layout, pageId)
  const insert = <T,>(list: T[], item: T, idOf: (x: T) => string): T[] => {
    const ref = place.before ?? place.after
    const at = ref ? list.findIndex(x => idOf(x) === ref) : -1
    if (at === -1) return [...list, item]
    const next = [...list]
    next.splice(place.before ? at : at + 1, 0, item)
    return next
  }
  if (to === 'root') return { v: 1, rows: insert<MenuRow>(rows, page(pageId), r => r.id) }
  return {
    v: 1,
    rows: rows.map(r => (r.type === 'group' && r.id === to ? { ...r, children: insert<string>(r.children, pageId, x => x) } : r)),
  }
}

/** Move a whole group among the main-list rows (groups never nest). */
export function moveGroup(layout: MenuLayout, groupId: string, place: Place = {}): MenuLayout {
  const row = layout.rows.find(r => r.type === 'group' && r.id === groupId)
  if (!row) return layout
  const rest = layout.rows.filter(r => r !== row)
  const ref = place.before ?? place.after
  const at = ref ? rest.findIndex(r => r.id === ref) : -1
  if (at === -1) return { v: 1, rows: [...rest, row] }
  const rows = [...rest]
  rows.splice(place.before ? at : at + 1, 0, row)
  return { v: 1, rows }
}

/**
 * Drag-and-drop "drop on this row": put `activeId` where `overId` is. Same container -> the usual list move (down = after, up =
 * before). Across containers -> before the row dropped on. A group dropped on a page inside another group lands next to that group.
 */
export function reorder(layout: MenuLayout, activeId: string, overId: string): MenuLayout {
  if (activeId === overId) return layout
  if (isGroupId(activeId)) {
    // Groups only move among the main-list rows: aim at the over row, or at the group that holds it.
    const target = isGroupId(overId) ? overId : (containerOf(layout, overId) === 'root' ? overId : containerOf(layout, overId))
    if (!target || target === activeId) return layout
    const ids = layout.rows.map(r => r.id)
    const down = ids.indexOf(activeId) < ids.indexOf(target)
    return moveGroup(layout, activeId, down ? { after: target } : { before: target })
  }
  const from = containerOf(layout, activeId)
  if (from === null) return layout
  // Dropped on a group: into it (at the end) — unless it is ALREADY in that group (the name bar, a gap or the padding under the
  // rows is "the group", not "the end of the group"): then it stays exactly where the drag left it.
  if (isGroupId(overId)) return from === overId ? layout : movePage(layout, activeId, overId)
  const to = containerOf(layout, overId)
  if (to === null) return layout
  if (from !== to) return movePage(layout, activeId, to, { before: overId })
  const list = to === 'root' ? layout.rows.map(r => r.id) : (layout.rows.find(r => r.type === 'group' && r.id === to) as GroupRow).children
  const down = list.indexOf(activeId) < list.indexOf(overId)
  return movePage(layout, activeId, to, down ? { after: overId } : { before: overId })
}

// Flat result shapes on purpose: this project's TypeScript is not strict, so a success/failure union would not narrow on `ok`.
export interface NameCheck { ok: boolean; name?: string; error?: string }

/** A group name must be 1-24 characters and not repeat another group's name (spaces and capitals ignored). */
export function checkGroupName(layout: MenuLayout, raw: unknown, exceptGroupId?: string): NameCheck {
  const name = cleanName(raw)
  if (!name) return { ok: false, error: 'Give the group a name.' }
  const clash = layout.rows.some(r => r.type === 'group' && r.id !== exceptGroupId && r.name.toLowerCase() === name.toLowerCase())
  if (clash) return { ok: false, error: 'You already have a group with that name.' }
  return { ok: true, name }
}

export function newGroupId(layout: MenuLayout, rand: () => number = Math.random): string {
  const used = new Set(layout.rows.map(r => r.id))
  for (let i = 0; i < 50; i++) {
    const id = GROUP_ID_PREFIX + Math.floor(rand() * 36 ** 5).toString(36).padStart(5, '0')
    if (!used.has(id)) return id
  }
  return GROUP_ID_PREFIX + Date.now().toString(36)
}

export interface CreateResult { ok: boolean; layout?: MenuLayout; id?: string; error?: string }

/** A new, empty group at the top of the main list. */
export function createGroup(layout: MenuLayout, rawName: unknown, rand?: () => number): CreateResult {
  if (layout.rows.filter(r => r.type === 'group').length >= MAX_GROUPS) return { ok: false, error: `You can have up to ${MAX_GROUPS} groups.` }
  const check = checkGroupName(layout, rawName)
  if (!check.ok || !check.name) return { ok: false, error: check.error ?? 'Give the group a name.' }
  const id = newGroupId(layout, rand)
  return { ok: true, id, layout: { v: 1, rows: [{ type: 'group', id, name: check.name, children: [] }, ...layout.rows] } }
}

export interface RenameResult { ok: boolean; layout?: MenuLayout; error?: string }

export function renameGroup(layout: MenuLayout, groupId: string, rawName: unknown): RenameResult {
  if (!layout.rows.some(r => r.type === 'group' && r.id === groupId)) return { ok: false, error: 'That group no longer exists.' }
  const check = checkGroupName(layout, rawName, groupId)
  if (!check.ok || !check.name) return { ok: false, error: check.error ?? 'Give the group a name.' }
  const name = check.name
  return { ok: true, layout: { v: 1, rows: layout.rows.map(r => (r.type === 'group' && r.id === groupId ? { ...r, name } : r)) } }
}

/** Remove a group; its pages stay, in the main list, where the group was. */
export function deleteGroup(layout: MenuLayout, groupId: string): MenuLayout {
  const at = layout.rows.findIndex(r => r.type === 'group' && r.id === groupId)
  if (at === -1) return layout
  const g = layout.rows[at] as GroupRow
  const rows = [...layout.rows]
  rows.splice(at, 1, ...g.children.map(page))
  return { v: 1, rows }
}

export function layoutsEqual(a: MenuLayout, b: MenuLayout): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/* ───────────────────────────── choosing what to show at page load ───────────────────────────── */

/** What reading the account's saved layout came back with: a layout, nothing saved (or no table yet), or "could not read". */
export type ServerLayoutStatus = 'saved' | 'none' | 'unavailable'

/** This browser's own copy: `synced` is false while an edit has not reached the account yet. */
export interface LocalCopy { layout: MenuLayout; synced: boolean }

export interface StartChoice { layout: MenuLayout; /** an unsent edit was found: send it again */ resend: boolean }

/**
 * The ONE rule for which layout the menu starts from (the browser decides after load; the server's copy is only the first paint).
 * - An edit that never reached the account (failed save) wins over the account's older copy and is sent again — the toast promised
 *   "kept on this computer", so it must survive a reload.
 * - Otherwise the account's copy wins.
 * - Nothing on the account: a copy that was already SYNCED means it was reset elsewhere, so it is ignored; an unsynced one (the table
 *   may not exist yet) is used and sent; else the person's old per-browser order is carried over; else the standard layout.
 * - Account unreadable: show this browser's copy (or the old order, or standard) but never send anything — the real saved layout may
 *   be there, and editing is switched off by the caller.
 */
export function pickLayoutOnLoad(input: {
  status: ServerLayoutStatus
  server: MenuLayout | null
  local: LocalCopy | null
  legacy: readonly string[] | null
  pageIds: readonly string[]
}): StartChoice {
  const { status, server, local, legacy, pageIds } = input
  const localLayout = local ? reconcileLayout(local.layout, pageIds) : null
  const fromLegacy = () => (legacy && legacy.length > 0 ? layoutFromLegacyOrder(legacy, pageIds) : standardLayout(pageIds))
  if (status === 'unavailable') return { layout: localLayout ?? fromLegacy(), resend: false }
  if (local && !local.synced && localLayout) return { layout: localLayout, resend: true }
  if (status === 'saved' && server) return { layout: reconcileLayout(server, pageIds), resend: false }
  return { layout: fromLegacy(), resend: false }
}
