/**
 * A tiny recording fake of the supabase-js query builder for unit tests.
 *
 * Every builder method records itself and returns the same chain; awaiting the chain (or calling single / maybeSingle)
 * asks the script what the database "answered". `calls` keeps every query for assertions such as "nothing was written".
 */
export interface Op { m: string; args: unknown[] }
export interface Call { table: string; ops: Op[] }
export interface Answer { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null }

export function makeFakeDb(script: (call: Call) => Answer | void) {
  const calls: Call[] = []
  const METHODS = [
    'select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'not', 'is', 'like', 'ilike',
    'gte', 'lte', 'gt', 'lt', 'or', 'order', 'limit', 'range', 'single', 'maybeSingle', 'contains',
  ]
  function from(table: string) {
    const call: Call = { table, ops: [] }
    calls.push(call)
    const chain: Record<string, unknown> = {}
    for (const m of METHODS) {
      chain[m] = (...args: unknown[]) => { call.ops.push({ m, args }); return chain }
    }
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const a = (script(call) ?? { data: null, error: null }) as Answer
      return Promise.resolve({ data: a.data ?? null, error: a.error ?? null, count: a.count ?? null }).then(resolve, reject)
    }
    return chain
  }
  const writes = () => calls.filter(c => c.ops.some(o => ['insert', 'update', 'delete', 'upsert'].includes(o.m)))
  return { db: { from }, calls, writes }
}

export const hasOp = (c: Call, m: string, ...args: unknown[]) =>
  c.ops.some(o => o.m === m && args.every((a, i) => JSON.stringify(o.args[i]) === JSON.stringify(a)))
export const opArgs = (c: Call, m: string) => c.ops.find(o => o.m === m)?.args
