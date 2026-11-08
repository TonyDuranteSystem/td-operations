/**
 * Window event fired after the IRS tracking number of a job is saved (components/flows/irs-tracking-entry.tsx). The step bar and the action
 * buttons listen for it and drop a red refusal that is stale now ("Save the tracking number before the job can move on") — the same idea as
 * the document-upload event (production end-to-end test 2026-11-07: the red line stayed on screen after the number had been saved).
 */
export const FLOW_TRACKING_SAVED_EVENT = 'flow-tracking-saved'

export interface FlowTrackingSavedDetail {
  serviceDeliveryId: string
}
