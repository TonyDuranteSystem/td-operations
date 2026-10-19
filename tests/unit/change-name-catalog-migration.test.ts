/**
 * The Company Change Name catalog migration (scripts/migrations/20261019-1000-change-name-8-steps.sql) is DATA the code
 * depends on: stage names are matched EXACTLY by the advance gates, the e-sign hook, the client-visible-document
 * allowlist and the layouts' own buttons. This reads the SQL and checks it against the code-side constants, so a
 * rename in one place can never silently disconnect the other.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHANGE_NAME_STAGES, CHANGE_NAME_STAGE_ORDER } from '@/lib/flows/change-name-stages'
import { parseStageLayout, STAGE_COMPONENT_TYPES } from '@/lib/flows/stage-layout'

const sql = readFileSync(join(process.cwd(), 'scripts/migrations/20261019-1000-change-name-8-steps.sql'), 'utf8')
const undo = readFileSync(join(process.cwd(), 'scripts/migrations/20261019-1000-change-name-8-steps.UNDO.sql'), 'utf8')

// The seven-row VALUES list of section 4: ('Stage', 'waiting_on', 'label', 'label_it', 'client text', 'staff text', $j$layout$j$)
const rowPattern = /\(\s*'([^']+)',\s*'(client|us|outside|none)',\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)',\s*'((?:[^']|'')+)',\s*\$j\$(.+?)\$j\$\)/gs
const rows = [...sql.matchAll(rowPattern)].map((m) => ({
  stage: m[1],
  waitingOn: m[2],
  label: m[3].replace(/''/g, "'"),
  labelIt: m[4].replace(/''/g, "'"),
  clientText: m[5].replace(/''/g, "'"),
  staffText: m[6].replace(/''/g, "'"),
  layoutRaw: m[7],
}))

describe('change-name 8-step migration ⇄ code constants', () => {
  it('describes all eight steps, in order, with exactly the names the code matches on', () => {
    expect(rows.map((r) => r.stage)).toEqual([...CHANGE_NAME_STAGE_ORDER])
    // the preflight/verification list strings carry the same order
    const list = CHANGE_NAME_STAGE_ORDER.map((n, i) => `${i + 1}:${n}`).join(',')
    expect(sql.split(list).length - 1).toBeGreaterThanOrEqual(2)
  })

  it('whose turn each step is — client / us / client / us / outside / us / client / none', () => {
    expect(rows.map((r) => r.waitingOn)).toEqual(['client', 'us', 'client', 'us', 'outside', 'us', 'client', 'none'].slice(0, rows.length))
    expect(sql).toContain("'client,us,client,us,outside,us,client,none'")
  })

  it('every step has client wording in both languages and a staff instruction (nothing blank)', () => {
    for (const r of rows) {
      expect(r.label.length, r.stage).toBeGreaterThan(3)
      expect(r.labelIt.length, r.stage).toBeGreaterThan(3)
      expect(r.clientText.length, r.stage).toBeGreaterThan(10)
      expect(r.staffText.length, r.stage).toBeGreaterThan(10)
    }
  })

  it('every layout is valid JSON, keeps ALL its components (the parser silently drops unknown ones) and ends in the chat or buttons', () => {
    for (const r of rows) {
      const raw = JSON.parse(r.layoutRaw) as { components: Array<{ type: string }>; description?: string }
      expect(typeof raw.description, r.stage).toBe('string')
      for (const c of raw.components) expect(STAGE_COMPONENT_TYPES as readonly string[], `${r.stage}: ${c.type}`).toContain(c.type)
      const parsed = parseStageLayout(raw)!
      expect(parsed.components.length, r.stage).toBe(raw.components.length)
    }
  })

  it('every "advance" button points at the NEXT step, by its exact name (so a button can never skip or dead-end)', () => {
    rows.forEach((r, i) => {
      const parsed = parseStageLayout(JSON.parse(r.layoutRaw))!
      const buttons = parsed.components.filter((c) => c.type === 'action_buttons').flatMap((c) => c.actions ?? [])
      const targets = buttons.map((b) => (typeof b === 'string' ? null : b.target)).filter((t): t is string => !!t)
      if (i === rows.length - 1) {
        expect(targets, r.stage).toEqual([]) // "Completed" has no way forward
      } else {
        expect(targets, r.stage).toEqual([CHANGE_NAME_STAGE_ORDER[i + 1]])
      }
    })
  })

  it('the names panel, the form-signing panel and the upload tools are where the flow needs them', () => {
    const typesOf = (stage: string) => parseStageLayout(JSON.parse(rows.find((r) => r.stage === stage)!.layoutRaw))!.components.map((c) => c.type)
    expect(typesOf(CHANGE_NAME_STAGES.collect)).toContain('formation_names')
    expect(typesOf(CHANGE_NAME_STAGES.check)).toEqual(expect.arrayContaining(['formation_names', 'esign_panel']))
    expect(typesOf(CHANGE_NAME_STAGES.sign)).toContain('esign_panel')
    expect(typesOf(CHANGE_NAME_STAGES.file)).toContain('document_upload')
    expect(typesOf(CHANGE_NAME_STAGES.wait)).toContain('document_upload')
  })

  it('an upload on these steps never moves the job by itself (staff presses the button after checking)', () => {
    for (const r of rows) {
      const parsed = parseStageLayout(JSON.parse(r.layoutRaw))!
      for (const c of parsed.components.filter((x) => x.type === 'document_upload')) expect(c.autoAdvance, r.stage).toBe(false)
    }
  })

  it('no layout carries a link to a website (the state filing link is Luca\'s to supply — never guessed)', () => {
    for (const r of rows) expect(r.layoutRaw, r.stage).not.toMatch(/external_link|https?:\/\//)
  })

  it('"Completed" is the one finishing step, not shown to the client; "Waiting for the state" needs the stamped document', () => {
    expect(sql).toContain("completes_service = (v.stage_name = 'Completed')")
    expect(sql).toContain("client_visible    = (v.stage_name <> 'Completed')")
    expect(sql).toContain("requires_document_to_advance = (stage_name = 'Waiting for the state')")
  })

  it('the document rule is switched on AFTER the jobs are re-keyed (the database trigger would otherwise judge the re-key)', () => {
    expect(sql.indexOf('UPDATE public.service_deliveries')).toBeGreaterThan(0)
    expect(sql.indexOf("requires_document_to_advance = (stage_name = 'Waiting for the state')")).toBeGreaterThan(sql.lastIndexOf('UPDATE public.service_deliveries'))
  })

  it('a job already completed at the old last step goes to "Completed"; an active one to "Update our records"', () => {
    expect(sql).toMatch(/SET stage = 'Completed', stage_order = 8\s+WHERE service_type = 'Company Change Name' AND stage = 'Form Change Name received from the SoS' AND status = 'completed'/)
    expect(sql).toContain("('Form Change Name received from the SoS',  'Update our records',              6)")
  })

  it('is one transaction with a backup, refuses to commit a wrong result, and retires the old workflow card', () => {
    expect(sql).toMatch(/^BEGIN;/m)
    expect(sql).toMatch(/^COMMIT;/m)
    expect(sql).toContain('zz_change_name_8_steps_backup')
    expect(sql).toContain('unexpected step list after the change')
    expect(sql).toContain("workflow_slug = 'company_change_name_workflow'")
    expect(sql).toContain("catalog_id = 'task_workflows'")
    expect(sql).toContain("'draft'")
  })

  it('the UNDO refuses once any job is past step 2, restores from the backup and then drops it', () => {
    expect(undo).toContain("stage NOT IN ('Collect three company names', 'Check names and client confirms')")
    expect(undo).toContain('RAISE EXCEPTION')
    expect(undo).toContain('FROM public.zz_change_name_8_steps_backup')
    expect(undo).toContain('DROP TABLE public.zz_change_name_8_steps_backup')
  })
})
