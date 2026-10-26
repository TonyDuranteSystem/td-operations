import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CONTRACT_TEXT_SOURCES, CONTRACT_TEXT_STATUSES } from '@/lib/contracts/service-contract-texts'

const sql = readFileSync(join(process.cwd(), 'scripts/migrations/20261026-1000-service-contract-texts.sql'), 'utf8')
const undo = readFileSync(join(process.cwd(), 'scripts/migrations/20261026-1000-service-contract-texts.UNDO.sql'), 'utf8')

const listIn = (re: RegExp) => {
  const m = re.exec(sql)
  expect(m, String(re)).not.toBeNull()
  return Array.from((m as RegExpExecArray)[1].matchAll(/'([^']+)'/g)).map((x) => x[1])
}

describe('migration 20261026-1000 — service contract texts', () => {
  it('the status and source lists inside the lock trigger are exactly the TypeScript ones', () => {
    expect(listIn(/NEW\.status NOT IN \(([^)]*)\)/)).toEqual([...CONTRACT_TEXT_STATUSES])
    expect(listIn(/NEW\.source NOT IN \(([^)]*)\)/)).toEqual([...CONTRACT_TEXT_SOURCES])
  })

  it('has NO CHECK value list: on the shared sandbox such a constraint turns the CI "code <-> database contract" check red on every other branch until it is registered and the production snapshot is refreshed', () => {
    // a value list would read "CHECK (col IN ('a','b'))" / "= ANY (ARRAY[...])"
    expect(sql).not.toMatch(/CHECK\s*\([^)]*\bIN\s*\(/i)
    expect(sql).not.toMatch(/CHECK\s*\([^)]*ANY\s*\(/i)
    // an earlier version of this migration had them: re-running must remove them if present
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS service_contract_texts_status_check')
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS service_contract_texts_source_check')
  })

  it('the two checks it keeps are shape rules (a regex and a type test), not value lists', () => {
    const checks = Array.from(sql.matchAll(/CHECK\s*\(([^\n]*)\),?\n/g)).map((m) => m[1])
    expect(checks.length).toBe(2)
    expect(checks.join(' ')).toContain("contract_type ~ '^custom_[a-z0-9_]+$'")
    expect(checks.join(' ')).toContain("jsonb_typeof(content) = 'object'")
  })

  it('locks the table (the repo rule for every new table) and has an undo that removes everything it added', () => {
    expect(sql).toContain('marketing_lock_all_tables()')
    for (const piece of ['DROP COLUMN IF EXISTS contract_texts', 'DROP FUNCTION IF EXISTS public.approve_service_contract_text', 'DROP TABLE IF EXISTS public.service_contract_texts', 'DROP FUNCTION IF EXISTS public.service_contract_texts_guard']) expect(undo).toContain(piece)
  })
})
