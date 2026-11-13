/**
 * A tiny in-memory stand-in for the supabase client, just big enough to run the booking code against real filters:
 * select / insert / update / upsert / delete with eq, neq, is, in, ilike, contains, not, gte, lte, order, limit, maybeSingle, single, and unique indexes
 * (a duplicate answers { code: '23505' } like Postgres). A table can be made "missing" (code 42P01) or failing, to test the tolerant readers.
 * Test helper only: holds no real data.
 */

type Row = Record<string, unknown>
export interface MiniDbOptions {
  /** per table: column lists that must be unique; rows with a null in any of those columns are exempt (like a partial unique index) */
  unique?: Record<string, string[][]>
  /** tables that do not exist: any query answers { code: '42P01' } */
  missing?: string[]
  /** tables whose every query answers an error */
  failing?: Record<string, string>
  /** a table + operation that fails once it is reached: e.g. { 'contact_calls:insert': 'boom' } */
  failOps?: Record<string, string>
}

export interface MiniDb {
  from(table: string): unknown
  tables: Record<string, Row[]>
  log: Array<{ table: string; op: string; args: unknown }>
  ids: () => string
}

export function miniDb(seed: Record<string, Row[]> = {}, opts: MiniDbOptions = {}): MiniDb {
  const tables: Record<string, Row[]> = {}
  for (const [t, rows] of Object.entries(seed)) tables[t] = rows.map((r) => ({ ...r }))
  const log: MiniDb['log'] = []
  let n = 0
  const ids = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`

  const like = (value: unknown, pattern: string): boolean => {
    if (typeof value !== 'string') return false
    // ILIKE: % = any run, _ = one char, backslash escapes
    let re = ''
    for (let i = 0; i < pattern.length; i++) {
      const ch = pattern[i]
      if (ch === '\\' && i + 1 < pattern.length) { re += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue }
      if (ch === '%') re += '.*'
      else if (ch === '_') re += '.'
      else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${re}$`, 'i').test(value)
  }

  function from(table: string) {
    const filters: Array<(r: Row) => boolean> = []
    let op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
    let payload: Row | Row[] | null = null
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    let orderBy: { col: string; asc: boolean } | null = null
    let max: number | null = null
    let returning = false
    const b: Record<string, unknown> = {}

    const fail = (): { data: null; error: { code?: string; message: string } } | null => {
      if (opts.missing?.includes(table)) return { data: null, error: { code: '42P01', message: `relation "${table}" does not exist` } }
      if (opts.failing?.[table]) return { data: null, error: { message: opts.failing[table] } }
      if (opts.failOps?.[`${table}:${op}`]) return { data: null, error: { message: opts.failOps[`${table}:${op}`] } }
      return null
    }
    const violates = (row: Row, skipIndex = -1): boolean => {
      for (const cols of opts.unique?.[table] ?? []) {
        if (cols.some((c) => row[c] === null || row[c] === undefined)) continue
        if ((tables[table] ?? []).some((o, i) => i !== skipIndex && cols.every((c) => o[c] === row[c]))) return true
      }
      return false
    }
    const run = (): { data: unknown; error: { code?: string; message: string } | null } => {
      const f = fail()
      if (f) return f
      const rows = (tables[table] ??= [])
      const matching = () => rows.filter((r) => filters.every((fn) => fn(r)))
      log.push({ table, op, args: payload })
      if (op === 'select') {
        let out = matching().map((r) => ({ ...r }))
        if (orderBy) { const { col, asc } = orderBy; out = out.sort((a, c) => (String(a[col] ?? '') < String(c[col] ?? '') ? -1 : 1) * (asc ? 1 : -1)) }
        if (max !== null) out = out.slice(0, max)
        return { data: out, error: null }
      }
      if (op === 'insert' || op === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload]) as Row[]
        const created: Row[] = []
        for (const item of list) {
          const row: Row = { id: ids(), created_at: '2026-11-13T12:00:00.000Z', ...item }
          if (op === 'upsert' && upsertOpts.onConflict) {
            const cols = upsertOpts.onConflict.split(',').map((c) => c.trim())
            const dup = rows.find((o) => cols.every((c) => o[c] === row[c]))
            if (dup) { if (!upsertOpts.ignoreDuplicates) Object.assign(dup, item); continue }
          }
          if (violates(row)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          rows.push(row)
          created.push({ ...row })
        }
        return { data: returning ? created : null, error: null }
      }
      if (op === 'update') {
        const hit = matching()
        for (const r of hit) {
          const next = { ...r, ...(payload as Row) }
          const idx = rows.indexOf(r)
          if (violates(next, idx)) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
          Object.assign(r, payload)
        }
        return { data: returning ? hit.map((r) => ({ ...r })) : null, error: null }
      }
      const hit = matching()
      tables[table] = rows.filter((r) => !hit.includes(r))
      return { data: returning ? hit : null, error: null }
    }

    const add = (name: string, fn: (...a: unknown[]) => (r: Row) => boolean) => { b[name] = (...a: unknown[]) => { filters.push(fn(...a)); return b } }
    add('eq', (c, v) => (r) => r[c as string] === v)
    add('neq', (c, v) => (r) => r[c as string] !== v)
    add('is', (c, v) => (r) => (v === null ? r[c as string] === null || r[c as string] === undefined : r[c as string] === v))
    add('in', (c, v) => (r) => (v as unknown[]).includes(r[c as string]))
    add('ilike', (c, p) => (r) => like(r[c as string], p as string))
    add('contains', (c, v) => (r) => Array.isArray(r[c as string]) && (v as unknown[]).every((x) => (r[c as string] as unknown[]).includes(x)))
    add('gte', (c, v) => (r) => String(r[c as string] ?? '') >= String(v))
    add('lte', (c, v) => (r) => String(r[c as string] ?? '') <= String(v))
    add('not', (c, o, v) => (r) => (o === 'is' && v === null ? r[c as string] !== null && r[c as string] !== undefined : true))
    b.or = () => b // a PostgREST .or() text filter is NOT interpreted: it matches every row (use a seed that already fits)
    b.select = () => { returning = true; return b }
    b.order = (col: string, o?: { ascending?: boolean }) => { orderBy = { col, asc: o?.ascending !== false }; return b }
    b.limit = (k: number) => { max = k; return b }
    b.insert = (p: Row | Row[]) => { op = 'insert'; payload = p; return b }
    b.update = (p: Row) => { op = 'update'; payload = p; return b }
    b.upsert = (p: Row | Row[], o?: { onConflict?: string; ignoreDuplicates?: boolean }) => { op = 'upsert'; payload = p; upsertOpts = o ?? {}; return b }
    b.delete = () => { op = 'delete'; return b }
    b.maybeSingle = async () => { const r = run(); if (r.error) return r; const rows = r.data as Row[] | null; return { data: rows?.[0] ?? null, error: null } }
    b.single = async () => { const r = run(); if (r.error) return r; const rows = r.data as Row[] | null; return rows?.[0] ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } } }
    b.then = (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => new Promise((resolve) => resolve(run())).then(onF, onR)
    return b
  }

  return { from, tables, log, ids }
}
