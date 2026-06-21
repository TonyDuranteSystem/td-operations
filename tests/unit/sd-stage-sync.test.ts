import { describe, it, expect } from 'vitest'
import { mergeSdStageIntoTaskMeta } from '@/lib/tasks/sd-stage-sync'

describe('mergeSdStageIntoTaskMeta', () => {
  it('sets sd_stage and workflow_state to the new stage', () => {
    const out = mergeSdStageIntoTaskMeta({ sd_stage: 'State Filing', workflow_state: 'State Filing' }, 'Filed with State')
    expect(out.sd_stage).toBe('Filed with State')
    expect(out.workflow_state).toBe('Filed with State')
  })

  it('preserves other task_meta keys', () => {
    const out = mergeSdStageIntoTaskMeta(
      { service_delivery_id: 'sd-1', sla_state: 'warn', sd_stage: 'Data Collection' },
      'Wizard Submitted',
    )
    expect(out.service_delivery_id).toBe('sd-1')
    expect(out.sla_state).toBe('warn')
    expect(out.sd_stage).toBe('Wizard Submitted')
    expect(out.workflow_state).toBe('Wizard Submitted')
  })

  it('handles null/undefined meta', () => {
    expect(mergeSdStageIntoTaskMeta(null, 'EIN Received')).toEqual({
      sd_stage: 'EIN Received',
      workflow_state: 'EIN Received',
    })
    expect(mergeSdStageIntoTaskMeta(undefined, 'EIN Received')).toEqual({
      sd_stage: 'EIN Received',
      workflow_state: 'EIN Received',
    })
  })

  it('does not mutate the input', () => {
    const input = { sd_stage: 'old', keep: 1 }
    mergeSdStageIntoTaskMeta(input, 'new')
    expect(input.sd_stage).toBe('old')
  })
})
