/**
 * Which tables does the BROWSER touch with the anonymous key, and how?
 *
 * ⛔ WHY THIS EXISTS — 2026-07-21 incident.
 *
 * A migration revoked `UPDATE` on ss4_applications and form_8832_applications
 * from `anon`, on the stated basis that "the signing pages only read —
 * verified explicitly". They do not: both pages write the signature. The check
 * had been a text search for the literal chain `supabasePublic.from(`, and both
 * files assign the client to a local first:
 *
 *     const supabase = supabasePublic      // ss4:65, 8832:56
 *     ...
 *     await supabase.from("ss4_applications").update({ status: "signed", ... })
 *
 * so the search returned nothing and the grant was pulled. Because none of those
 * writes destructure `error`, and the pages call `setSigned(true)` regardless,
 * the client saw "Signed", the PDF reached storage via the service-key route,
 * and the row never recorded the signature. Silent.
 *
 * A regex cannot see through an alias. This module therefore parses the real
 * TypeScript AST and resolves the identifiers actually bound to the anon client:
 *
 *   1. the imported `supabasePublic`
 *   2. any local aliased to it            (`const supabase = supabasePublic`)
 *   3. any hand-rolled anon client        (`createClient(url, NEXT_PUBLIC_SUPABASE_ANON_KEY)`)
 *      — several pages build their own rather than importing the shared one.
 *
 * RULE: before revoking any `anon` privilege, this must say the browser does not
 * use it. Never a grep.
 *
 * Deliberately conservative: when a `.from()` base cannot be resolved with
 * confidence it is reported as UNKNOWN rather than dropped, so an unreadable
 * call site fails loudly instead of silently licensing a revoke.
 */
import ts from "typescript"

export type AnonOp = "select" | "insert" | "update" | "upsert" | "delete"

export interface AnonTableUsage {
  /** table name as written in .from("…") */
  table: string
  op: AnonOp
  line: number
  /** how the client identifier was established — for the failure message */
  via: "supabasePublic" | "alias" | "inline-anon-client"
}

export interface AnonBucketUsage {
  /** bucket name as written in .storage.from("…") */
  bucket: string
  line: number
}

export interface AnonUsageResult {
  usages: AnonTableUsage[]
  /**
   * Storage buckets the browser reaches with the anon key. Reported separately
   * because they are a distinct exposure: a table can be locked down while the
   * signed PDFs it points at stay downloadable from an open bucket, which is
   * half a fix. `.storage.from()` is NOT a table and must never be counted as
   * one — an earlier version of this module conflated them.
   */
  buckets: AnonBucketUsage[]
  /** `.from()` calls on a resolved anon client where NO operation was recognised */
  unknownOps: Array<{ table: string; line: number }>
}

const OPS: readonly AnonOp[] = ["select", "insert", "update", "upsert", "delete"]
const ANON_KEY_ENV = "NEXT_PUBLIC_SUPABASE_ANON_KEY"

/** Does this expression evaluate to a Supabase client built with the anon key? */
function isInlineAnonClient(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = ts.isIdentifier(node.expression)
    ? node.expression.text
    : ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name.text
      : ""
  if (callee !== "createClient") return false
  // any argument mentioning the public anon key env var
  return node.arguments.some(a => a.getText().includes(ANON_KEY_ENV))
}

/**
 * Parse one file and report every table the anon client reads or writes.
 *
 * @param source file contents
 * @param fileName used only for TS parsing/JSX detection
 */
export function findAnonTableUsage(source: string, fileName = "file.tsx"): AnonUsageResult {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

  // ── pass 1: identifiers bound to the anon client ────────────────────────────
  const anonIds = new Map<string, AnonTableUsage["via"]>()

  const collect = (node: ts.Node): void => {
    // import { supabasePublic } from '.../public-client'
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        const imported = (el.propertyName ?? el.name).text
        if (imported === "supabasePublic") anonIds.set(el.name.text, "supabasePublic")
      }
    }
    // const x = supabasePublic            → alias
    // const x = createClient(u, ANON_KEY) → inline anon client
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isIdentifier(node.name)) {
      const init = node.initializer
      if (ts.isIdentifier(init) && anonIds.has(init.text)) {
        anonIds.set(node.name.text, "alias")
      } else if (isInlineAnonClient(init)) {
        anonIds.set(node.name.text, "inline-anon-client")
      }
    }
    ts.forEachChild(node, collect)
  }
  // two sweeps: an alias can be declared before the collector reaches its source
  collect(sf)
  collect(sf)

  // ── pass 2: <anonId>….from("table")….<op>() ────────────────────────────────
  const usages: AnonTableUsage[] = []
  const buckets: AnonBucketUsage[] = []
  const unknownOps: Array<{ table: string; line: number }> = []

  /** walk left down a property/call chain to the root identifier */
  const rootIdentifier = (expr: ts.Expression): string | null => {
    let cur: ts.Node = expr
    for (;;) {
      if (ts.isIdentifier(cur)) return cur.text
      if (ts.isPropertyAccessExpression(cur)) { cur = cur.expression; continue }
      if (ts.isCallExpression(cur)) { cur = cur.expression; continue }
      if (ts.isNonNullExpression(cur) || ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur)) { cur = cur.expression; continue }
      return null
    }
  }

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "from" &&
      node.arguments.length > 0
    ) {
      const root = rootIdentifier(node.expression.expression)
      const via = root ? anonIds.get(root) : undefined
      const arg = node.arguments[0]
      if (via && ts.isStringLiteralLike(arg)) {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

        // `.storage.from("bucket")` is a BUCKET, not a table. Distinguished by
        // the object immediately left of `.from` being `.storage`.
        const base = node.expression.expression
        const isStorage = ts.isPropertyAccessExpression(base) && base.name.text === "storage"
        if (isStorage) {
          buckets.push({ bucket: arg.text, line })
          ts.forEachChild(node, visit)
          return
        }

        const table = arg.text

        // climb OUTWARD from .from(...) collecting the operations applied to it
        const found: AnonOp[] = []
        let cur: ts.Node = node
        while (cur.parent) {
          const p: ts.Node = cur.parent
          if (ts.isPropertyAccessExpression(p) && p.expression === cur) {
            const name = p.name.text as AnonOp
            if ((OPS as readonly string[]).includes(name)) found.push(name)
            cur = p
            continue
          }
          if (
            ts.isCallExpression(p) || ts.isAwaitExpression(p) ||
            ts.isNonNullExpression(p) || ts.isParenthesizedExpression(p)
          ) { cur = p; continue }
          break
        }

        if (found.length === 0) {
          unknownOps.push({ table, line })
        } else {
          // Array.from, not a Set spread/for-of: this project's tsconfig has no
          // downlevelIteration, so iterating a Set directly fails the build.
          for (const op of Array.from(new Set(found))) usages.push({ table, op, line, via })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  return { usages, buckets, unknownOps }
}

/** Fold many files into `table → set of operations the browser performs`. */
export function summariseAnonUsage(
  files: Array<{ file: string; source: string }>,
): Map<string, Map<AnonOp, string[]>> {
  const out = new Map<string, Map<AnonOp, string[]>>()
  for (const { file, source } of files) {
    const { usages } = findAnonTableUsage(source, file)
    for (const u of usages) {
      if (!out.has(u.table)) out.set(u.table, new Map())
      const byOp = out.get(u.table)!
      if (!byOp.has(u.op)) byOp.set(u.op, [])
      byOp.get(u.op)!.push(`${file}:${u.line}`)
    }
  }
  return out
}

/** The privilege a given operation requires from the `anon` role. */
export function privilegeFor(op: AnonOp): "SELECT" | "INSERT" | "UPDATE" | "DELETE" {
  switch (op) {
    case "select": return "SELECT"
    case "insert": return "INSERT"
    case "upsert": return "INSERT" // upsert needs INSERT (and UPDATE when it conflicts)
    case "update": return "UPDATE"
    case "delete": return "DELETE"
  }
}
