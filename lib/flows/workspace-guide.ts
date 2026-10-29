/**
 * The workspace GUIDE — "the CRM must understand the situation and show the person the right thing to do" (Antonio 2026-10-28, dev job e3215801;
 * the model for ALL workspaces). Pure: no database, no React, so the rules are unit-tested and the page only renders them.
 *
 * What it does: the "A workspace step is waiting for this document" pop-up opens the case at /flows/<id>?guide=<document type>. A small card plus a
 * glowing ring then shows the REAL next click, one at a time, and never clicks for the person:
 *   1. press the stage button(s) that move the case to the stage whose upload box takes this document (only if the case is not there yet),
 *   2. choose the file, check the document type, press the upload button in that box.
 * Nothing is scripted per service. Everything comes from data the workspace already has: the stage buttons carry their target stage
 * (`advance_next` + `target` in pipeline_stages.stage_layout) and each upload box carries its Storage document type (`documentType`). A step
 * finishes only when the person REALLY did it: the plan is recomputed from the LIVE case every time the page refreshes, so after the button press
 * the stage has changed and the plan has one step fewer.
 *
 * Answers from Antonio (2026-10-28): the guide always starts from "Open the workspace" with a "don't guide me again" choice; a case that is NOT at a
 * stage where this document is expected only gets a warning (no guided walk); a guide for CLIENTS in the portal wizards comes later.
 */
import { parseStageLayout } from '@/lib/flows/stage-layout'
import type { StorageStepHint } from '@/lib/flows/storage-step-rules'

// ── what the page hands the guide ──────────────────────────────────────────────────────────────────────────────────────────────

export interface GuideAction { label: string; target: string }
export interface GuideBox { label: string; documentType: string | null }
export interface GuideStageDef { name: string; order: number; actions: GuideAction[]; boxes: GuideBox[] }

/** The stages of one service as the guide needs them: each stage's forward buttons (with their target stage) and upload boxes. */
export function stageDefsFromRows(rows: ReadonlyArray<{ stage_name: string; stage_order: number; stage_layout: unknown }>): GuideStageDef[] {
  const out: GuideStageDef[] = []
  for (const r of rows) {
    const layout = parseStageLayout(r.stage_layout)
    const actions: GuideAction[] = []
    const boxes: GuideBox[] = []
    for (const c of layout?.components ?? []) {
      if (c.type === 'action_buttons') {
        for (const a of c.actions ?? []) {
          // only the generic forward button carries its own target; the older fixed keys (approve, file_with_irs…) are resolved inside the button
          // component and are not guided yet (their services have no typed upload box yet)
          if (typeof a === 'object' && a !== null && a.key === 'advance_next' && typeof a.target === 'string' && a.target) {
            actions.push({ label: a.label || 'Advance to Next Stage', target: a.target })
          }
        }
      } else if (c.type === 'document_upload') {
        boxes.push({ label: c.label || 'Upload Document', documentType: typeof c.documentType === 'string' && c.documentType ? c.documentType : null })
      }
    }
    out.push({ name: r.stage_name, order: r.stage_order, actions, boxes })
  }
  return out.sort((a, b) => a.order - b.order)
}

// ── the plan ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type GuideStep =
  | { kind: 'press'; stage: string; label: string; target: string }
  | { kind: 'upload'; stage: string; boxLabel: string; documentType: string }

export type GuidePlan =
  | { kind: 'steps'; steps: GuideStep[] }
  /** WARN ONLY (Antonio's answer 2): the case is not at a stage where this document is expected — nothing to click yet. */
  | { kind: 'not_ready'; currentStage: string | null; boxStage: string | null; boxLabel: string | null }
  | { kind: 'inactive'; reason: 'finished' | 'no_box' }

const FINISHED = ['completed', 'cancelled']

/**
 * The steps from where the case is NOW to the upload box that takes `documentType`.
 *  - the case is finished -> inactive;
 *  - no stage of this service has a box typed `documentType` -> inactive (that workspace has not been moved over yet);
 *  - the case is already at that stage -> just the upload step;
 *  - `readyStages` (the stages where the pop-up says a matching file is waiting) is given and the case is NOT in it -> not_ready (warn only);
 *  - otherwise the shortest chain of forward buttons to the nearest such stage, then the upload step; no chain -> not_ready.
 */
export function planGuide(input: {
  stages: readonly GuideStageDef[]
  currentStage: string | null
  status: string | null
  documentType: string
  readyStages: readonly string[] | null
}): GuidePlan {
  if (input.status && FINISHED.indexOf(input.status) !== -1) return { kind: 'inactive', reason: 'finished' }
  const withBox = input.stages.filter((s) => s.boxes.some((b) => b.documentType === input.documentType))
  if (withBox.length === 0) return { kind: 'inactive', reason: 'no_box' }
  const boxOf = (s: GuideStageDef) => s.boxes.find((b) => b.documentType === input.documentType)!
  const uploadStep = (s: GuideStageDef): GuideStep => ({ kind: 'upload', stage: s.name, boxLabel: boxOf(s).label, documentType: input.documentType })

  const here = input.currentStage ? input.stages.find((s) => s.name === input.currentStage) ?? null : null
  if (here && withBox.some((s) => s.name === here.name)) return { kind: 'steps', steps: [uploadStep(here)] }

  const nearest = withBox[0]
  if (input.readyStages && (!input.currentStage || input.readyStages.indexOf(input.currentStage) === -1)) {
    return { kind: 'not_ready', currentStage: input.currentStage, boxStage: nearest.name, boxLabel: boxOf(nearest).label }
  }
  if (!here) return { kind: 'not_ready', currentStage: input.currentStage, boxStage: nearest.name, boxLabel: boxOf(nearest).label }

  const found = pressPath(input.stages, here.name, new Set(withBox.map((s) => s.name)))
  if (found) return { kind: 'steps', steps: [...found.press, uploadStep(found.reached)] }
  return { kind: 'not_ready', currentStage: input.currentStage, boxStage: nearest.name, boxLabel: boxOf(nearest).label }
}

export type PressStep = Extract<GuideStep, { kind: 'press' }>

/**
 * The shortest chain of forward buttons from the stage `fromName` to the nearest stage in `targets` (breadth-first; a loop in the pipeline cannot
 * hang it). `press` is empty when `fromName` already is a target. null = no chain of guided buttons reaches a target. Shared by the guide and by
 * the "workspace step is waiting" pop-up (which tells staff the exact buttons), so the two always say the same thing.
 */
export function pressPath(stages: readonly GuideStageDef[], fromName: string, targets: ReadonlySet<string>): { press: PressStep[]; reached: GuideStageDef } | null {
  const byName = new Map(stages.map((s) => [s.name, s] as const))
  const start = byName.get(fromName)
  if (!start) return null
  if (targets.has(start.name)) return { press: [], reached: start }
  const queue: Array<{ stage: GuideStageDef; path: PressStep[] }> = [{ stage: start, path: [] }]
  const seen = new Set<string>([start.name])
  while (queue.length > 0) {
    const cur = queue.shift()!
    for (const a of cur.stage.actions) {
      const next = byName.get(a.target)
      if (!next || seen.has(next.name)) continue
      seen.add(next.name)
      const path: PressStep[] = [...cur.path, { kind: 'press', stage: cur.stage.name, label: a.label, target: a.target }]
      if (targets.has(next.name)) return { press: path, reached: next }
      queue.push({ stage: next, path })
    }
  }
  return null
}

// ── which part of the upload box to circle ─────────────────────────────────────────────────────────────────────────────────────

export type UploadSub = 'choose' | 'type' | 'submit'

/** The upload box has three things to do in order: choose the file, (if the box has a type picker) pick the type, press the upload button. */
export function uploadSubStep(state: { fileChosen: boolean; hasTypePicker: boolean; typeValue: string }): UploadSub {
  if (!state.fileChosen) return 'choose'
  if (state.hasTypePicker && state.typeValue === '') return 'type'
  return 'submit'
}

/** The page parts the ring looks for (the workspace components carry these data attributes). */
export function ringSelector(step: GuideStep, sub: UploadSub): string {
  if (step.kind === 'press') return `[data-guide-action="${attr(step.target)}"]`
  return `[data-guide-box="${attr(step.documentType)}"] [data-guide-part="${sub}"]`
}

function attr(v: string): string {
  return v.replace(/["\\]/g, '')
}

// ── the words on the card (plain English, one thing at a time) ─────────────────────────────────────────────────────────────────

export interface GuideCardText { title: string; body: string }

export function guideCardText(input: {
  step: GuideStep
  sub: UploadSub
  /** "the IRS approval letter (CP565)" */
  asks: string
  /** what the workspace step does once the file is uploaded ("read the ITIN from the letter and save it on the contact", …) */
  does: readonly string[]
  /** the step after this one, when it is the upload (so a button step can say where it leads) */
  next: GuideStep | null
}): GuideCardText {
  const { step, sub, asks, does, next } = input
  if (step.kind === 'press') {
    const lead = next && next.kind === 'upload' ? ` Then you can upload ${asks} in the "${next.boxLabel}" box.` : ''
    return {
      title: `Press "${step.label}"`,
      body: `The case is at "${step.stage}". This button moves it to "${step.target}".${lead}`,
    }
  }
  if (sub === 'choose') {
    return { title: 'Choose the file', body: `In the "${step.boxLabel}" box, press "Choose file" and pick ${asks}.` }
  }
  if (sub === 'type') {
    return { title: 'Check the document type', body: 'Pick what kind of document this is, in the "Document type" list of the box.' }
  }
  const after = does.length > 0 ? ` The system will then: ${does.join('; ')}.` : ''
  return { title: 'Press the upload button', body: `It is the blue button in the "${step.boxLabel}" box.${after}` }
}

export function guideNotReadyText(plan: Extract<GuidePlan, { kind: 'not_ready' }>, asks: string): GuideCardText {
  const where = plan.boxStage ? ` It is uploaded when the case reaches "${plan.boxStage}".` : ''
  return {
    title: 'Not ready for this document yet',
    body: `The case is at "${plan.currentStage ?? 'an unknown stage'}", so ${asks} is not expected yet.${where} There is nothing to click for it now.`,
  }
}

export const GUIDE_DONE_TEXT: GuideCardText = {
  title: 'Uploaded',
  body: 'Look at the message in the upload box: a green line means it is all done; a yellow warning says what is still missing.',
}

export const GUIDE_FINISHED_TEXT: GuideCardText = {
  title: 'This case is already finished',
  body: 'There is nothing more to do here.',
}

// ── the guide's link and the document it is about ──────────────────────────────────────────────────────────────────────────────

const GUIDE_PARAM = /^[a-z0-9_]{1,60}$/

/** The ?guide= value from the address: a document type slug, or null for anything else. */
export function parseGuideParam(raw: unknown): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  return typeof v === 'string' && GUIDE_PARAM.test(v) ? v : null
}

/** What the workspace's own upload boxes say about the step this document belongs to (the words, what the workspace does, and the stages where it is waiting). */
export function guideHintFor(hints: readonly StorageStepHint[], serviceType: string, documentType: string): { asks: string; does: string[]; readyStages: string[] } | null {
  for (const h of hints) {
    if (h.serviceType === serviceType && h.documentTypes.indexOf(documentType) !== -1) {
      return { asks: h.asks, does: h.workspaceDoes.map((e) => e.text), readyStages: [...h.stages] }
    }
  }
  return null
}

// ── "don't guide me again" ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const GUIDE_OFF_KEY = 'td-workspace-guide-off'
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** True when this person chose "don't guide me again" on this computer. Never throws (blocked storage = guide stays on). */
export function readGuideOff(s: StorageLike | null | undefined): boolean {
  try {
    return !!s && s.getItem(GUIDE_OFF_KEY) === '1'
  } catch {
    return false
  }
}

export function writeGuideOff(s: StorageLike | null | undefined, off: boolean): void {
  try {
    if (!s) return
    if (off) s.setItem(GUIDE_OFF_KEY, '1')
    else s.removeItem(GUIDE_OFF_KEY)
  } catch { /* blocked storage: the choice just lasts until the page closes */ }
}
