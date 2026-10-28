/**
 * Guard (dev job e3215801): the workspace GUIDE is wired end to end — the pop-up link carries ?guide=, the workspace page mounts the guide only for a
 * document the step table knows, and the real workspace parts carry the markers the ring looks for. The rules themselves are in workspace-guide.test.ts;
 * this pins the connections, which need a whole browser to run.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { ringSelector } from '@/lib/flows/workspace-guide'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('workspace guide wiring', () => {
  it('the stage buttons carry the target stage the ring looks for', () => {
    expect(read('components/flows/action-buttons.tsx')).toContain('data-guide-action={action.targetStage}')
    // and the selector the engine builds for a button step is exactly that attribute
    expect(ringSelector({ kind: 'press', stage: 'A', label: 'x', target: 'ITIN Approved' }, 'choose')).toBe('[data-guide-action="ITIN Approved"]')
  })
  it('the upload box carries its document type and its three parts (choose / type / submit)', () => {
    const src = read('components/flows/document-upload.tsx')
    expect(src).toContain('data-guide-box={documentType || undefined}')
    for (const part of ['choose', 'type', 'submit']) expect(src).toContain(`data-guide-part="${part}"`)
    expect(ringSelector({ kind: 'upload', stage: 's', boxLabel: 'b', documentType: 'itin_letter' }, 'submit')).toBe('[data-guide-box="itin_letter"] [data-guide-part="submit"]')
  })
  it('the workspace page starts the guide only from ?guide= and only for a document the step table knows', () => {
    const src = read('app/(dashboard)/flows/[id]/page.tsx')
    expect(src).toContain('parseGuideParam(searchParams?.guide)')
    expect(src).toContain('guideHintFor(sd.service_type, guideType)')
    expect(src).toMatch(/\{guideType && guideHint && \(\s*<WorkspaceGuide/)
  })
  it('the pop-up\'s "Open the workspace" link carries the guide request', () => {
    expect(read('lib/flows/storage-step-rules.ts')).toMatch(/workspacePath: `\/flows\/\$\{c\.sdId\}\?guide=\$\{m\.hint\.documentTypes\[0\]\}`/)
  })
  it('the guide never clicks for the person: it only draws a ring and a card (no .click() / dispatchEvent of clicks / form submit in the component)', () => {
    const src = read('components/flows/workspace-guide.tsx')
    expect(src).not.toMatch(/\.click\(\)/)
    expect(src).not.toMatch(/dispatchEvent\(\s*new (Mouse|Pointer)Event/)
    expect(src).not.toMatch(/requestSubmit|\.submit\(\)/)
  })
  it('the Windows tour and the guide share ONE ring and ONE "one tour at a time" lock', () => {
    expect(read('components/windows/windows-tour.tsx')).toContain("from '@/components/ui/tour-ring'")
    const g = read('components/flows/workspace-guide.tsx')
    expect(g).toContain("from '@/components/ui/tour-ring'")
    expect(g).toContain("from '@/lib/ui/tour-lock'")
  })
})
