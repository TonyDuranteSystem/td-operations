/**
 * Every label key the Generate Documents screen REFERENCES must EXIST.
 *
 * ── WHY THIS TEST EXISTS ──
 *
 * Dev job `61f184ca`. Scripted edits removed two label definitions while leaving
 * the code that renders them. The lookup helper falls back to returning the key
 * itself, so nothing crashed, nothing failed, and the refusal screen would have
 * shown a client the literal strings "ownerUnresolvedTitle" and
 * "ownerUnresolvedBody" in an amber box on a legal-document screen. It reached a
 * pushed commit because that path had never been rendered in a browser.
 *
 * Antonio's ruling, 2026-08-12: "'This path has never been rendered in a browser'
 * is the actual finding, and I am not fixing it by asking a human to look at it
 * once. Add a test that every label key referenced by that screen exists in the
 * label table, and make it cover the whole file, not just these two strings. A
 * missing key must fail the suite, not reach a client as a developer string."
 *
 * So this reads the source and checks the two sets against each other. It is
 * deliberately source-scanning rather than render-based: a render test only covers
 * the branches it happens to enter, and the branch that broke was precisely the one
 * nobody entered.
 *
 * BOTH DIRECTIONS are checked. A referenced-but-missing key is a client-facing
 * defect; a defined-but-unreferenced key is dead copy that misleads the next
 * person about what the screen says.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCE = join(process.cwd(), 'app/portal/documents/generate/generate-documents-client.tsx')

function readSource(): string {
  return readFileSync(SOURCE, 'utf8')
}

/**
 * Comments are prose, not references. Without this the scan matched an example
 * written INSIDE a comment (`l('literal')`) and reported it as a missing label —
 * a test failing on its own documentation is a test nobody will trust for long.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Keys defined in the LABELS table: `  someKey: {` or `  someKey: { en: ... }`. */
function definedKeys(src: string): Set<string> {
  const table = src.slice(src.indexOf('const LABELS'), src.indexOf('function l('))
  return new Set(Array.from(table.matchAll(/^ {2}([A-Za-z][A-Za-z0-9_]*):\s*\{/gm), m => m[1]))
}

/**
 * Keys referenced anywhere OUTSIDE the label table — whether through the lookup
 * helper directly (`l('someKey', lang)`) or through a mapping variable that picks
 * a key by condition and hands it to the helper.
 *
 * Deliberately ANY quoted occurrence, not just `l('...')`: the first version of
 * this test only understood the literal form, so eight reason-specific keys chosen
 * through a variable read as "defined but never used" while being very much in
 * use. A scan that only sees one calling convention silently stops covering the
 * screen the moment someone writes a normal indirection.
 */
function referencedKeys(src: string): Set<string> {
  // Direct calls…
  const code = stripComments(src)
  const direct = Array.from(code.matchAll(/\bl\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g), m => m[1])
  // …plus the ONE declared indirection table. Keys chosen by condition and handed
  // to the helper are still references; a scan that only understands the literal
  // form reported eight live keys as dead the moment that indirection appeared.
  // Any future indirection must go in a table like this, or it is not covered.
  const tableStart = code.indexOf('const REFUSAL_KEYS')
  const indirect = tableStart === -1
    ? []
    : Array.from(code.slice(tableStart, code.indexOf('}', tableStart)).matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g), m => m[1])
  return new Set([...direct, ...indirect])
}

describe('Generate Documents label coverage', () => {
  const src = readSource()
  const defined = definedKeys(src)
  const referenced = referencedKeys(src)

  it('finds both sets — the scan itself must not silently match nothing', () => {
    // Without this, a regex that stopped matching would make every assertion below
    // pass vacuously, which is the same class of failure the test guards against.
    expect(defined.size).toBeGreaterThan(20)
    expect(referenced.size).toBeGreaterThan(15)
  })

  it('THE DEFECT: every referenced key is defined — a missing one reaches the client as a developer string', () => {
    const missing = [...referenced].filter(k => !defined.has(k))
    expect(missing, `referenced but not defined in LABELS: ${missing.join(', ')}`).toEqual([])
  })

  it('specifically covers the refusal banner, which no browser pass had ever rendered', () => {
    for (const key of [
      'refusalOwnerUnclearTitle', 'refusalOwnerUnclearBody',
      'refusalNoNameTitle', 'refusalNoNameBody',
      'refusalNoContactsTitle', 'refusalNoContactsBody',
      'refusalNoRosterTitle', 'refusalNoRosterBody',
    ]) {
      expect(defined.has(key), `refusal label ${key} is not defined`).toBe(true)
      expect(referenced.has(key), `refusal label ${key} is never used`).toBe(true)
    }
  })

  it('every defined key is actually used — dead copy misleads the next reader', () => {
    const unused = [...defined].filter(k => !referenced.has(k))
    expect(unused, `defined in LABELS but never referenced: ${unused.join(', ')}`).toEqual([])
  })

  it('every label carries BOTH languages — the portal is bilingual', () => {
    const table = src.slice(src.indexOf('const LABELS'), src.indexOf('function l('))
    for (const key of defined) {
      const block = table.slice(table.indexOf(`  ${key}: {`))
      const body = block.slice(0, block.indexOf('},') + 2)
      expect(body, `${key} is missing an English string`).toMatch(/\ben:\s*'/)
      expect(body, `${key} is missing an Italian string`).toMatch(/\bit:\s*'/)
    }
  })
})

describe('Generate Documents refusal copy', () => {
  const src = readSource()

  it('STANDING RULE: no blocking reason is hidden in a tooltip', () => {
    // Antonio, 2026-08-12: "the reason for a refusal goes in the visible text,
    // never in a tooltip. Our clients are on phones, where a tooltip does not
    // exist at all. If the only explanation for why they cannot proceed is on
    // hover, they have no explanation."
    const tooltips = Array.from(src.matchAll(/title=\{[^}]*\}/g), m => m[0])
    const explanatory = tooltips.filter(t => /proceed|must|cannot|can't|required|needs/i.test(t))
    expect(explanatory, `blocking reason found in a tooltip: ${explanatory.join(' | ')}`).toEqual([])
  })

  it('client-facing copy points at the portal, not at an email address', () => {
    // The form and the correction both reach the client IN THEIR PORTAL, and
    // client-facing copy must never say otherwise (Antonio, 2026-08-12).
    const table = src.slice(src.indexOf('const LABELS'), src.indexOf('function l('))
    expect(table).not.toMatch(/support@tonydurante\.us/)
  })
})
