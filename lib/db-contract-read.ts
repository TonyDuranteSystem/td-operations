/**
 * Reading a LIVE database's CHECK constraints through Supabase.
 *
 * The app has no Postgres connection string — but it does have a service-role client, and
 * production exposes `exec_sql_readonly()`. That is the whole reason the production half of
 * this gate needs no new credential: the app already holds legitimate access to the database
 * it is deployed against. We do not have to invent a second way in.
 *
 * (The CLI script uses a direct `pg` connection instead, when a developer has one. Same query,
 * same comparison — see CONSTRAINT_QUERY. The transport must never change the answer.)
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { CONSTRAINT_QUERY, rowsToDefs, type ConstraintDefs } from "@/lib/db-contract"

interface ConstraintRow {
  name: string
  def: string
}

function isConstraintRow(v: unknown): v is ConstraintRow {
  if (typeof v !== "object" || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.name === "string" && typeof r.def === "string"
}

/**
 * Read every CHECK constraint in `public` from whatever database this client points at.
 *
 * THROWS on failure — deliberately. The caller is a monitor whose entire job is to notice
 * that the database disagrees with the code; a monitor that silently returns "no constraints"
 * when the read fails would report a clean bill of health for an empty result, which is the
 * exact shape of the bug it exists to catch (an error nobody checked, read as "fine").
 */
export async function readLiveConstraints(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rpc() is untyped for exec_sql_readonly's Json return
  client: SupabaseClient<any, any, any>,
): Promise<ConstraintDefs> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
  const { data, error } = await (client as any).rpc("exec_sql_readonly", {
    sql_query: CONSTRAINT_QUERY,
  })

  if (error) {
    throw new Error(`Could not read the live constraint set: ${error.message}`)
  }

  if (!Array.isArray(data)) {
    throw new Error(
      `exec_sql_readonly returned ${typeof data}, not an array of rows. Refusing to treat an ` +
        `unreadable result as an empty constraint set — that would report "no drift" for a failed read.`,
    )
  }

  const rows = data.filter(isConstraintRow)
  if (rows.length !== data.length) {
    throw new Error(
      `The constraint query returned ${data.length} rows but only ${rows.length} had the expected ` +
        `{name, def} shape. Refusing to compare against a partially-understood result.`,
    )
  }

  if (rows.length === 0) {
    throw new Error(
      `The database reports ZERO check constraints. That is almost certainly a permissions or ` +
        `query failure rather than the truth — and "zero constraints" is precisely the state that ` +
        `makes every other check pass vacuously. Refusing.`,
    )
  }

  return rowsToDefs(rows)
}
