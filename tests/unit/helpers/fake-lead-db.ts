/** A tiny in-memory stand-in for the Supabase client: just enough of the query builder for the lead intake tests. */
type Row = Record<string, unknown>
type Result = { data: Row[]; error: { code?: string; message: string } | null }
const UNIQUE: Record<string, string> = { marketing_leads: "leadgen_id", marketing_leadgen_events: "leadgen_id" }

export class FakeDb {
  tables: Record<string, Row[]> = {}
  failTables = new Set<string>()
  seq = 0
  rows(t: string): Row[] { return (this.tables[t] ??= []) }
  from(t: string) { return new Query(this, t) }
}

/** SQL LIKE (with backslash escapes) to a RegExp, case-insensitive. */
function likeToRegExp(pat: string): RegExp {
  let out = ""
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]
    if (ch === "\\" && i + 1 < pat.length) { out += pat[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); continue }
    if (ch === "%") out += ".*"
    else if (ch === "_") out += "."
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp("^" + out + "$", "i")
}

class Query {
  private op: "select" | "insert" | "update" = "select"
  private payload: Row = {}
  private filters: Array<(r: Row) => boolean> = []
  private lim = Infinity
  private off = 0
  constructor(private db: FakeDb, private t: string) {}
  select(_cols?: string) { return this }
  insert(row: Row) { this.op = "insert"; this.payload = row; return this }
  update(patch: Row) { this.op = "update"; this.payload = patch; return this }
  eq(c: string, v: unknown) { this.filters.push(r => r[c] === v); return this }
  is(c: string, v: null) { this.filters.push(r => (r[c] ?? null) === v); return this }
  in(c: string, vs: unknown[]) { this.filters.push(r => vs.includes(r[c])); return this }
  lt(c: string, v: string) { this.filters.push(r => String(r[c] ?? "") < v); return this }
  ilike(c: string, pat: string) { const re = likeToRegExp(pat); this.filters.push(r => re.test(String(r[c] ?? ""))); return this }
  order() { return this }
  limit(n: number) { this.lim = n; return this }
  range(from: number, to: number) { this.off = from; this.lim = to - from + 1; return this }
  private run(): Result {
    if (this.db.failTables.has(this.t)) return { data: [], error: { message: `forced failure on ${this.t}` } }
    const all = this.db.rows(this.t)
    if (this.op === "insert") {
      const key = UNIQUE[this.t]
      if (key && all.some(r => r[key] === this.payload[key])) return { data: [], error: { code: "23505", message: "duplicate key" } }
      const row: Row = { id: `${this.t}-${++this.db.seq}`, status: "pending", attempts: 0, ...this.payload }
      all.push(row)
      return { data: [row], error: null }
    }
    const hit = all.filter(r => this.filters.every(f => f(r)))
    if (this.op === "update") { hit.forEach(r => Object.assign(r, this.payload)); return { data: hit, error: null } }
    return { data: hit.slice(this.off, this.off + this.lim), error: null }
  }
  maybeSingle() { const r = this.run(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error }) }
  single() { const r = this.run(); return Promise.resolve({ data: r.data[0] ?? null, error: r.error ?? (r.data[0] ? null : { message: "no row" }) }) }
  then<T>(res: (v: Result) => T) { return Promise.resolve(this.run()).then(res) }
}
