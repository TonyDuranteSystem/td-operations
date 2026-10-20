/**
 * Company Change Name has a closing bookkeeping step ("Completed", catalog client_visible = false) that is not one of the
 * seven steps the client is told about. The client's progress lists leave it out — for THIS service only
 * (SERVICES_HIDING_INVISIBLE_STEPS); the same flag on a renewal step is deliberately not honoured.
 */
import { describe, it, expect } from 'vitest'
import {
  buildFlowSteps,
  buildJourneySteps,
  computeFlowProgress,
  stageClientVisibleFlag,
  SERVICES_HIDING_INVISIBLE_STEPS,
  type FlowStageRow,
} from '@/lib/flows/flow-progress'
import { CHANGE_NAME_STAGE_ORDER } from '@/lib/flows/change-name-stages'

const row = (name: string, order: number, hidden = false): FlowStageRow => ({
  stage_name: name,
  stage_order: order,
  client_label: name,
  client_label_it: null,
  client_description: `about ${name}`,
  client_visible: hidden ? false : null,
})
const CN: FlowStageRow[] = CHANGE_NAME_STAGE_ORDER.map((n, i) => row(n, i + 1, i === 7))

describe('stageClientVisibleFlag', () => {
  it('passes the flag through only for services that honour it', () => {
    expect([...SERVICES_HIDING_INVISIBLE_STEPS]).toEqual(['Company Change Name'])
    expect(stageClientVisibleFlag('Company Change Name', false)).toBe(false)
    expect(stageClientVisibleFlag('Company Change Name', true)).toBeNull()
    expect(stageClientVisibleFlag('Company Change Name', null)).toBeNull()
    // the renewals carry a hidden step too — it stays shown (nothing changes for them)
    expect(stageClientVisibleFlag('State RA Renewal', false)).toBeNull()
    expect(stageClientVisibleFlag('State Annual Report', false)).toBeNull()
    expect(stageClientVisibleFlag(null, false)).toBeNull()
  })
})

describe('a hidden closing step', () => {
  it('journey: the client sees seven steps, not eight', () => {
    const j = buildJourneySteps(CN, 'Collect three company names', 'en')
    expect(j).toHaveLength(7)
    expect(j.map((s) => s.stageName)).not.toContain('Completed')
    expect(j[0].state).toBe('current')
    expect(j[6].state).toBe('future')
  })

  it('journey: a job on the last visible step shows it as current', () => {
    const j = buildJourneySteps(CN, 'Client updates the Operating Agreement', 'en')
    expect(j.map((s) => s.state)).toEqual(['completed', 'completed', 'completed', 'completed', 'completed', 'completed', 'current'])
  })

  it('journey: a FINISHED job (sitting on the hidden step) shows all seven as completed', () => {
    const j = buildJourneySteps(CN, 'Completed', 'en')
    expect(j).toHaveLength(7)
    expect(j.every((s) => s.state === 'completed')).toBe(true)
  })

  it('compact stepper and progress: seven steps, finished = 7 of 7', () => {
    const steps = buildFlowSteps(CN, 'Completed', 'en', 'Company Change Name', 'sd-1')!
    expect(steps).toHaveLength(7)
    expect(steps.every((s) => s.state === 'completed')).toBe(true)
    const p = computeFlowProgress(CN, 'Completed', 'en')
    expect(p).toMatchObject({ totalStages: 7, completedStages: 7 })
    expect(computeFlowProgress(CN, 'Waiting for the state', 'en')).toMatchObject({ totalStages: 7, completedStages: 5, currentLabel: 'Waiting for the state' })
  })

  it('a flow with no hidden step is unchanged (a renewal whose flag was never passed)', () => {
    const renewal: FlowStageRow[] = [row('Renewal Due', 1), row('Processed', 2), { ...row('Closed', 3), client_visible: null }]
    expect(buildJourneySteps(renewal, 'Closed', 'en')).toHaveLength(3)
    expect(buildJourneySteps(renewal, 'Closed', 'en')[2].state).toBe('current')
  })
})
