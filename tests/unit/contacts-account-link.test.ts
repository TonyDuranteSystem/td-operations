/**
 * Contacts link to accounts through a JOIN TABLE, never through a column on `contacts`.
 *
 * WHY THIS TEST EXISTS. Two places filtered `contacts` by an `account_id` column that does
 * not exist (verified against production and a local stack, 2026-07-20). PostgREST
 * returned an error; both call sites destructured only `data`, so the error vanished and
 * an empty result was read as "this client has no contacts". Live consequences, silently,
 * for every client:
 *   · the CRM sidebar assistant could not email ANY client — an empty address list is
 *     deliberately treated as "refuse every address", so it failed closed but invisibly;
 *   · the client boundary held only the account id, so a legitimate action naming one of
 *     that client's own contacts was refused as "a DIFFERENT client's id".
 * The same broken query existed in the Team Chat trigger.
 *
 * Nothing caught it for months because the failure looked exactly like a client with no
 * contacts. This test makes the bad shape impossible to reintroduce ANYWHERE, which a
 * per-call-site test could not do — the bug's defining feature was that it spread.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

const ROOTS = ['lib', 'app', 'components']
const SKIP_DIRS = new Set(['node_modules', '.next', 'deprecated'])

function sourceFiles(dir: string, acc: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, acc)
    else if (/\.tsx?$/.test(entry)) acc.push(full)
  }
  return acc
}

describe('contacts are never filtered by a non-existent account_id column', () => {
  it('no source file queries the contacts table by account_id', () => {
    const offenders: string[] = []

    for (const root of ROOTS) {
      for (const file of sourceFiles(root)) {
        const src = readFileSync(file, 'utf8')
        // Only look at statements that actually target the contacts table, so the many
        // legitimate `account_id.eq` filters on OTHER tables are not flagged.
        const chunks = src.split(/from\(\s*['"`]/)
        for (let i = 1; i < chunks.length; i++) {
          const chunk = chunks[i]
          if (!/^contacts['"`]/.test(chunk)) continue
          // The query builder chain for this call, up to the next `.from(` boundary.
          const chain = chunk.slice(0, 400)
          if (/account_id\.eq\.|eq\(\s*['"`]account_id['"`]/.test(chain)) {
            offenders.push(file)
          }
        }
      }
    }

    expect(
      offenders,
      `These files filter \`contacts\` by account_id, a column that does NOT exist. ` +
        `Resolve through the account_contacts join table instead — see the CRM sidebar ` +
        `send rails for the correct shape. Offenders: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it('the join table is the linkage the codebase actually uses', () => {
    // Guards the other direction: if account_contacts ever disappeared, the fix above
    // would have nothing to resolve through and this test's premise would be stale.
    const users = sourceFiles('lib').filter((f) => readFileSync(f, 'utf8').includes('account_contacts'))
    expect(users.length).toBeGreaterThan(0)
  })
})
