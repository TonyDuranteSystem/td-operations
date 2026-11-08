'use client'

import { useEffect, useState } from 'react'
import { FLOW_TRACKING_SAVED_EVENT, type FlowTrackingSavedDetail } from '@/lib/flows/tracking-saved-event'
import { withTrackingSaved } from '@/lib/flows/go-back-warnings'

/**
 * The extra lines a "move back" question shows (Go Back button and the step bar). The page works them out when it renders, so a tracking number
 * saved AFTER the page loaded was missing: the question never said the move would delete it (live test 2026-11-08). The tracking entry fires
 * FLOW_TRACKING_SAVED_EVENT when a number is saved — this hook adds the line then, without a reload.
 */
export function useGoBackWarnings(serviceDeliveryId: string, base: readonly string[] | undefined): string[] {
  const [trackingSaved, setTrackingSaved] = useState(false)
  useEffect(() => {
    function onSaved(e: Event) {
      const detail = (e as CustomEvent<FlowTrackingSavedDetail>).detail
      if (!detail || detail.serviceDeliveryId === serviceDeliveryId) setTrackingSaved(true)
    }
    window.addEventListener(FLOW_TRACKING_SAVED_EVENT, onSaved)
    return () => window.removeEventListener(FLOW_TRACKING_SAVED_EVENT, onSaved)
  }, [serviceDeliveryId])
  return withTrackingSaved(base ?? [], trackingSaved)
}
