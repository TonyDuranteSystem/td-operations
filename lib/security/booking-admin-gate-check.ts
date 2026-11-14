/**
 * A standing scan over the Booking page's own files: every API route must open with the shared admin gate, every page and layout must turn a non-admin away
 * before it reads anything, and nothing booking-related may fall back to the weaker staff checks. Pure (the test reads the files and passes the text in).
 *
 * How it reads a file (the scan FAILS CLOSED — anything it cannot read is a violation, never a pass):
 *   1. comments and the inside of strings/regexes are blanked, so a word in a comment or a string is never mistaken for code;
 *   2. EVERY export is found, in every form: `export async function X`, `export function X`, `export const X = async (...) => {}`, `export const X = async function () {}`,
 *      `export { a as X }`, `export { X }`, `export { a as X } from "..."`, `export * from "..."`, `export default ...`;
 *   3. each exported handler is resolved to its own body (a re-export is followed to the function in the same file; one from ANOTHER file or wrapped in a call is unreadable = violation);
 *   4. the guard must be inside THAT handler's body — not somewhere else in the file, not in a neighbouring handler.
 * The behaviour test (tests/unit/booking-admin-gate.test.ts) is the real proof of the gate; this scan keeps a future route from forgetting it at all.
 */

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
const READ_ONLY_METHODS = ["GET", "HEAD", "OPTIONS"]
/** Next.js route-segment settings: legitimate non-handler exports. */
const ROUTE_SETTINGS = ["dynamic", "dynamicParams", "revalidate", "fetchCache", "runtime", "preferredRegion", "maxDuration"]
/** Static page exports that carry no data. */
const PAGE_STATIC = [...ROUTE_SETTINGS, "metadata", "viewport"]
/** Page-level functions that run on the server and can read data: each must carry the guard too. */
const PAGE_FUNCTIONS = ["generateMetadata", "generateViewport", "generateStaticParams"]
const WEAK = [/requireStaffRoute/, /isDashboardUser/, /isStaffUser/, /\bisTeam\s*\(/]

// ─── reading the text ───────────────────────────────────────

const REGEX_PREV_WORDS = ["return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do"]

/**
 * Same length as the source: comments become spaces, the inside of strings / templates / regexes becomes spaces (quotes stay), code inside `${ }` stays code.
 * Returns null when the text ends inside a string, comment or template — it cannot be trusted then.
 */
export function blankNonCode(src: string): string | null {
  const out: string[] = []
  // a stack of modes: "code" (with a brace depth, to know when a `${` expression closes) or "template"
  const stack: Array<{ mode: "code"; depth: number; inTemplate: boolean } | { mode: "template" }> = [{ mode: "code", depth: 0, inTemplate: false }]
  const lastSignificant = (): string => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return out[k]
    return ""
  }
  const lastWord = (): string => {
    let k = out.length - 1
    while (k >= 0 && /\s/.test(out[k])) k--
    let w = ""
    while (k >= 0 && /[A-Za-z_$]/.test(out[k])) w = out[k--] + w
    return w
  }
  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]
    const c = src[i]
    const n = src[i + 1]
    if (top.mode === "template") {
      if (c === "\\") { out.push(" ", src[i + 1] === "\n" ? "\n" : " "); i += 2; continue }
      if (c === "`") { out.push("`"); stack.pop(); i++; continue }
      if (c === "$" && n === "{") { out.push(" ", " "); stack.push({ mode: "code", depth: 0, inTemplate: true }); i += 2; continue }
      out.push(c === "\n" ? "\n" : " ")
      i++
      continue
    }
    // code mode
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") { out.push(" "); i++ }
      continue
    }
    if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2)
      if (end < 0) return null
      for (let k = i; k < end + 2; k++) out.push(src[k] === "\n" ? "\n" : " ")
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      out.push(c)
      i++
      let closed = false
      while (i < src.length) {
        if (src[i] === "\\") { out.push(" ", " "); i += 2; continue }
        if (src[i] === c) { out.push(c); i++; closed = true; break }
        if (src[i] === "\n") break // an unescaped newline ends a plain string: unterminated
        out.push(" ")
        i++
      }
      if (!closed) return null
      continue
    }
    if (c === "`") { out.push("`"); stack.push({ mode: "template" }); i++; continue }
    if (c === "/") {
      const prev = lastSignificant()
      const isRegex = prev === "" || "(,=:[!&|?{};".includes(prev) || REGEX_PREV_WORDS.includes(lastWord())
      if (isRegex) {
        out.push("/")
        i++
        let inClass = false
        let closed = false
        while (i < src.length) {
          const ch = src[i]
          if (ch === "\\") { out.push(" ", " "); i += 2; continue }
          if (ch === "\n") break
          if (ch === "[") inClass = true
          else if (ch === "]") inClass = false
          else if (ch === "/" && !inClass) { out.push("/"); i++; closed = true; break }
          out.push(" ")
          i++
        }
        if (!closed) return null
        while (i < src.length && /[a-z]/.test(src[i])) { out.push(src[i]); i++ }
        continue
      }
    }
    if (c === "{") top.depth++
    if (c === "}") {
      if (top.depth === 0 && top.inTemplate) { out.push(" "); stack.pop(); i++; continue } // closes a `${ ... }`
      top.depth--
    }
    out.push(c)
    i++
  }
  if (stack.length !== 1) return null
  return out.join("")
}

/** Index just past the bracket that closes the one at `open` (text[open] is "(", "{", "[" or "<"), or -1. Strings are already blanked. */
function matchClose(text: string, open: number): number {
  const pair: Record<string, string> = { "(": ")", "{": "}", "[": "]", "<": ">" }
  const o = text[open]
  const c = pair[o]
  if (!c) return -1
  let depth = 0
  for (let k = open; k < text.length; k++) {
    // `=>` is not an angle bracket
    if (o === "<" && text[k] === ">" && text[k - 1] === "=") continue
    if (text[k] === o) depth++
    else if (text[k] === c) {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return -1
}

const skipWs = (t: string, i: number): number => {
  while (i < t.length && /\s/.test(t[i])) i++
  return i
}

type Parsed = { body: string } | { problem: string }

/** `at` points at the start of a function: `async function f(...) {}`, `function f() {}`, `async (...) => {}`, `(...) => {}`, `async x => {}`, `x => {}`. Returns the body's inner text. */
function parseFunctionAt(text: string, at: number): Parsed {
  let i = skipWs(text, at)
  if (/^async\b/.test(text.slice(i, i + 6))) i = skipWs(text, i + 5)
  let arrow = true
  if (/^function\b/.test(text.slice(i, i + 9))) {
    arrow = false
    i = skipWs(text, i + 8)
    if (text[i] === "*") return { problem: "a generator function cannot be a handler" }
    while (i < text.length && /[\w$]/.test(text[i])) i++ // the name
    i = skipWs(text, i)
  }
  if (text[i] === "<") { // generics
    const end = matchClose(text, i)
    if (end < 0) return { problem: "could not read the type arguments" }
    i = skipWs(text, end)
  }
  if (text[i] === "(") {
    const end = matchClose(text, i)
    if (end < 0) return { problem: "could not read the parameter list" }
    i = end
  } else if (arrow && /[A-Za-z_$]/.test(text[i] ?? "")) {
    while (i < text.length && /[\w$]/.test(text[i])) i++ // `x => ...`
  } else {
    return { problem: "is not a function this scan can read" }
  }
  // from here to the opening brace of the body: an optional return type, and for an arrow the `=>` at the top level
  let angle = 0
  let paren = 0
  let square = 0
  let k = i
  if (arrow) {
    for (; k < text.length; k++) {
      const ch = text[k]
      if (ch === "=" && text[k + 1] === ">" && angle === 0 && paren === 0 && square === 0) break
      if (ch === "<") angle++
      else if (ch === ">" && text[k - 1] !== "=") angle = Math.max(0, angle - 1)
      else if (ch === "(") paren++
      else if (ch === ")") paren = Math.max(0, paren - 1)
      else if (ch === "[") square++
      else if (ch === "]") square = Math.max(0, square - 1)
      else if (ch === ";") return { problem: "has no arrow this scan can find" }
    }
    if (k >= text.length) return { problem: "has no arrow this scan can find" }
    const b = skipWs(text, k + 2)
    if (text[b] !== "{") return { problem: "is an expression-bodied arrow: write it with a block so the guard can be seen" }
    const end = matchClose(text, b)
    return end < 0 ? { problem: "could not find where the handler ends" } : { body: text.slice(b + 1, end - 1) }
  }
  for (; k < text.length; k++) {
    const ch = text[k]
    if (ch === "<") angle++
    else if (ch === ">" && text[k - 1] !== "=") angle = Math.max(0, angle - 1)
    else if (ch === "(") paren++
    else if (ch === ")") paren = Math.max(0, paren - 1)
    else if (ch === "[") square++
    else if (ch === "]") square = Math.max(0, square - 1)
    else if (ch === "{" && angle === 0 && paren === 0 && square === 0) {
      let p = k - 1
      while (p >= i && /\s/.test(text[p])) p--
      const before = p >= i ? text[p] : ""
      // a "{" straight after ":" "|" "&" "," "<" "(" is a type literal in the return type, not the body
      if (before !== "" && ":|&,<(".includes(before)) {
        const e = matchClose(text, k)
        if (e < 0) return { problem: "could not read a type in the signature" }
        k = e - 1
        continue
      }
      const end = matchClose(text, k)
      return end < 0 ? { problem: "could not find where the handler ends" } : { body: text.slice(k + 1, end - 1) }
    }
  }
  return { problem: "has no body this scan can find" }
}

interface ExportedItem {
  name: string
  /** the handler's own body; null when it could not be resolved (then `problem` says why) */
  body: string | null
  problem?: string
}

/** Resolve a local name to a function in the same file. */
function resolveLocal(text: string, name: string): Parsed {
  const esc = name.replace(/\$/g, "\\$")
  const fn = new RegExp(`(?:^|[^\\w$.])(?:async\\s+)?function\\s*\\*?\\s*${esc}\\s*[(<]`).exec(text)
  if (fn) {
    const start = text.indexOf("function", fn.index)
    const asyncAt = text.lastIndexOf("async", start)
    const from = asyncAt >= 0 && /^\s*$/.test(text.slice(asyncAt + 5, start)) ? asyncAt : start
    return parseFunctionAt(text, from)
  }
  const cv = new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${esc}\\s*(?::[^=]+)?=\\s*`).exec(text)
  if (cv) return parseFunctionAt(text, cv.index + cv[0].length)
  return { problem: `is exported but not defined in this file as a function (re-exported from elsewhere or wrapped in a call)` }
}

/** Every export of the file, with each handler resolved. `ignored` forms (types) are skipped; anything else unreadable becomes an item with a problem. */
function findExports(text: string): ExportedItem[] {
  const items: ExportedItem[] = []
  const re = /(^|[^\w$.])export\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const after = m.index + m[0].length
    const rest = text.slice(after)
    let r: RegExpExecArray | null

    if ((r = /^\s+default\b/.exec(rest))) {
      const at = skipWs(text, after + r[0].length)
      const parsed = /^(?:async\s+)?function\b|^async\b|^\(|^[A-Za-z_$][\w$]*\s*=>/.test(text.slice(at, at + 40)) && !/^[A-Za-z_$][\w$]*\s*$/.test(text.slice(at).split(/[\n;]/)[0])
        ? parseFunctionAt(text, at)
        : (() => {
            const id = /^([A-Za-z_$][\w$]*)\s*(?:;|\n|$)/.exec(text.slice(at))
            return id ? resolveLocal(text, id[1]) : ({ problem: "has a default export this scan cannot read" } as Parsed)
          })()
      items.push("body" in parsed ? { name: "default", body: parsed.body } : { name: "default", body: null, problem: parsed.problem })
      continue
    }
    if (/^\s*\*/.test(rest)) {
      items.push({ name: "*", body: null, problem: 'uses "export *", which this scan cannot follow' })
      continue
    }
    if ((r = /^\s*\{/.exec(rest))) {
      const open = after + r[0].length - 1
      const end = matchClose(text, open)
      if (end < 0) { items.push({ name: "{", body: null, problem: "has an export list this scan cannot read" }); continue }
      const fromOther = /^\s*from\b/.test(text.slice(end, end + 12))
      for (const raw of text.slice(open + 1, end - 1).split(",")) {
        const spec = raw.trim()
        if (!spec) continue
        if (/^type\s/.test(spec)) continue // a type-only specifier
        const sm = /^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(spec)
        if (!sm) { items.push({ name: spec, body: null, problem: "has an export this scan cannot read" }); continue }
        const local = sm[1]
        const exported = sm[2] ?? sm[1]
        if (fromOther) { items.push({ name: exported, body: null, problem: "is re-exported from another file, which this scan cannot read" }); continue }
        const parsed = resolveLocal(text, local)
        items.push("body" in parsed ? { name: exported, body: parsed.body } : { name: exported, body: null, problem: parsed.problem })
      }
      continue
    }
    if (/^\s+type\b/.test(rest) || /^\s+interface\b/.test(rest)) continue // types are erased
    if ((r = /^\s+(?:declare\s+)?(async\s+)?function\b\s*(\*?)\s*([A-Za-z_$][\w$]*)/.exec(rest))) {
      if (r[2]) { items.push({ name: r[3], body: null, problem: "is a generator function, which cannot be a handler" }); continue }
      const at = after + rest.indexOf(r[0]) + (r[0].length - r[0].replace(/^\s+/, "").length)
      const parsed = parseFunctionAt(text, at)
      items.push("body" in parsed ? { name: r[3], body: parsed.body } : { name: r[3], body: null, problem: parsed.problem })
      continue
    }
    if ((r = /^\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+?)?=\s*/.exec(rest))) {
      const at = after + r[0].length
      const head = text.slice(at, at + 60)
      const looksLikeFunction = /^(?:async\s+)?function\b|^async\s*[(<A-Za-z_$]|^\(|^<|^[A-Za-z_$][\w$]*\s*=>/.test(head)
      if (!looksLikeFunction) {
        items.push({ name: r[1], body: null, problem: "is not written as a function this scan can read (a call, a wrapper or a value)" })
        continue
      }
      const parsed = parseFunctionAt(text, at)
      items.push("body" in parsed ? { name: r[1], body: parsed.body } : { name: r[1], body: null, problem: parsed.problem })
      continue
    }
    if ((r = /^\s+(?:const|let|var)\s*[{[]/.exec(rest))) {
      items.push({ name: "{", body: null, problem: "exports through destructuring, which this scan cannot read" })
      continue
    }
    const other = /^\s+(?:declare\s+)?(?:abstract\s+)?(class|enum|namespace)\s+([A-Za-z_$][\w$]*)/.exec(rest)
    items.push({ name: other ? other[2] : "?", body: null, problem: "is an export this scan cannot read" })
  }
  return items
}

// ─── the guards ─────────────────────────────────────────────

/** The gate must be the first `await` of the handler, its result kept and handed straight back when it is not null. */
function routeGateProblem(method: string, body: string): string | null {
  const firstAwait = body.search(/\bawait\b/)
  const needed = READ_ONLY_METHODS.includes(method) ? "await requireAdminRoute()" : "await requireAdminJsonRoute(req)"
  if (firstAwait < 0) return `${method} never calls the admin gate (it must open with ${needed})`
  const head = body.slice(firstAwait)
  const gate = READ_ONLY_METHODS.includes(method) ? /^await\s+requireAdmin(?:Json)?Route\s*\(/ : /^await\s+requireAdminJsonRoute\s*\(/
  const g = gate.exec(head)
  if (!g) return `${method} does not open with ${needed}`
  const kept = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(body.slice(0, firstAwait))
  if (!kept) return `${method} calls the gate but does not keep its answer (write: const denied = ${needed})`
  const open = firstAwait + g[0].length - 1
  const close = matchClose(body, open)
  if (close < 0) return `${method}: could not read the gate call`
  const name = kept[1]
  const handedBack = new RegExp(`^\\s*;?\\s*if\\s*\\(\\s*${name.replace(/\$/g, "\\$")}\\s*(?:!==?\\s*null\\s*)?\\)\\s*(?:\\{\\s*)?return\\s+${name.replace(/\$/g, "\\$")}\\b`)
  if (!handedBack.test(body.slice(close))) return `${method} calls the gate but does not hand its refusal back (write: if (${name}) return ${name})`
  return null
}

/** A page / layout function: an `if` whose condition turns a non-admin away (`!isSecureAdmin(...)`) and then redirects / 404s / returns / throws, before any database read. */
function pageGuardProblem(body: string): string | null {
  const ifRe = /\bif\s*\(/g
  let m: RegExpExecArray | null
  while ((m = ifRe.exec(body))) {
    const open = m.index + m[0].length - 1
    const end = matchClose(body, open)
    if (end < 0) continue
    const cond = body.slice(open + 1, end - 1)
    if (!/!\s*isSecureAdmin\s*\(/.test(cond)) continue
    if (!/^\s*(?:\{\s*)?(?:redirect|notFound|return|throw)\b/.test(body.slice(end))) continue
    if (/\.\s*(?:from|rpc)\s*\(|\bfetch\s*\(/.test(body.slice(0, m.index))) return "reads data BEFORE it checks the visitor is an admin"
    return null
  }
  return "never turns a non-admin away (expected: if (!isSecureAdmin(user)) redirect(...))"
}

// ─── the two public scans ───────────────────────────────────

export function adminRouteViolations(fileName: string, source: string): string[] {
  const problems: string[] = []
  for (const w of WEAK) if (w.test(source)) problems.push(`${fileName}: uses a weaker check (${w.source}) — booking routes are admin-only`)
  const text = blankNonCode(source)
  if (text === null) return [...problems, `${fileName}: the file ends inside a string, comment or template — this scan cannot read it`]
  for (const item of findExports(text)) {
    if (METHODS.includes(item.name)) {
      if (item.body === null) problems.push(`${fileName}: ${item.name} ${item.problem ?? "cannot be read"}`)
      else {
        const p = routeGateProblem(item.name, item.body)
        if (p) problems.push(`${fileName}: ${p}`)
      }
    } else if (ROUTE_SETTINGS.includes(item.name)) {
      continue
    } else {
      problems.push(`${fileName}: exports "${item.name}", which is neither a handler nor a route setting${item.problem ? ` (${item.problem})` : ""}`)
    }
  }
  return problems
}

/** Pages and layouts of the Booking page: the admin check must be in the function that renders (the middleware's admin-only list cannot be edited, so the page guards itself). */
export function adminPageViolations(fileName: string, source: string): string[] {
  const problems: string[] = []
  for (const w of WEAK) if (w.test(source)) problems.push(`${fileName}: uses a weaker check (${w.source}) — the Booking page is admin-only`)
  if (/^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source)) problems.push(`${fileName}: is a client component, which cannot check the visitor on the server — pages and layouts here must be server components`)
  const text = blankNonCode(source)
  if (text === null) return [...problems, `${fileName}: the file ends inside a string, comment or template — this scan cannot read it`]
  let sawDefault = false
  for (const item of findExports(text)) {
    const guarded = item.name === "default" || PAGE_FUNCTIONS.includes(item.name)
    if (item.name === "default") sawDefault = true
    if (guarded) {
      if (item.body === null) problems.push(`${fileName}: ${item.name} ${item.problem ?? "cannot be read"}`)
      else {
        const p = pageGuardProblem(item.body)
        if (p) problems.push(`${fileName}: ${item.name} ${p}`)
      }
    } else if (!PAGE_STATIC.includes(item.name)) {
      problems.push(`${fileName}: exports "${item.name}", which this scan does not know${item.problem ? ` (${item.problem})` : ""}`)
    }
  }
  if (!sawDefault) problems.push(`${fileName}: has no default export (every booking page and layout must render, and must check isSecureAdmin first)`)
  return problems
}
