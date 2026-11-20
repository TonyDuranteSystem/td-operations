/**
 * Dev job a6bbea09 — the database "a document must be uploaded on this step" lock stops counting an EMPTY file (20261120-0500 migration).
 * Proven on the sandbox inside a rolled-back transaction (empty refused, unknown size and real size allowed, UNDO restores the old behaviour);
 * this pins the files so the rule cannot drift away from the application lock it mirrors.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')
const MIG = 'scripts/migrations/20261120-0500-document-lock-ignores-empty-files.sql'
const UNDO = 'scripts/migrations/20261120-0500-document-lock-ignores-empty-files.UNDO.sql'
const CONDITION = 'AND (d.file_size IS NULL OR d.file_size > 0)'

describe('document lock ignores empty files — migration', () => {
  it('ships with its UNDO', () => {
    expect(existsSync(join(process.cwd(), MIG))).toBe(true)
    expect(existsSync(join(process.cwd(), UNDO))).toBe(true)
  })

  it('adds one condition: a row counts only when its size is unknown (NULL) or above zero', () => {
    const sql = read(MIG)
    expect(sql).toContain(CONDITION)
    // changes the function text in place — never replaces the whole function (owner, permissions, search_path and comments stay)
    expect(sql).toMatch(/replace\(v_src, v_anchor/)
    expect(sql).toMatch(/CREATE OR REPLACE FUNCTION public\.trg_delivery_document_to_advance\(\)/)
  })

  it('is safe to re-run and refuses an unexpected function shape', () => {
    const sql = read(MIG)
    expect(sql).toMatch(/already there — nothing to do/)
    expect(sql).toMatch(/not the expected shape/)
  })

  it('touches nothing else: no table, no row', () => {
    const sql = read(MIG).split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    expect(sql).not.toMatch(/\b(DELETE|INSERT|ALTER TABLE|DROP|TRUNCATE)\b/i)
    expect(sql).not.toMatch(/UPDATE\s+public\./i)
  })

  it('the UNDO takes the same condition out', () => {
    const undo = read(UNDO)
    expect(undo).toContain(CONDITION)
    expect(undo).toMatch(/replace\(v_src, v_cond, 'd\.flow_stage = p\.stage_name\);'\)/)
  })

  it('mirrors the application lock rule (null or above zero counts)', () => {
    const app = read('lib/service-delivery.ts')
    expect(app).toMatch(/d\.file_size === null \|\| d\.file_size === undefined \|\| d\.file_size > 0/)
  })
})
