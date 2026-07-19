'use client'

/**
 * React glue for HoldController — see hold-controller.ts for the rules and the
 * reasoning. This file deliberately holds no logic of its own: the property that
 * matters (a cancelled message is NEVER sent) is tested against the controller.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { HoldController, HOLD_MS } from '@/components/chat/hold-controller'

export { HOLD_MS }

export interface HoldToSend<T> {
  /** True while a message is waiting to go. */
  armed: boolean
  /** Whole seconds left, for the label. Never 0 while still catchable. */
  secondsLeft: number
  /** Start the hold — or, if already holding, send now (the second Enter press). */
  arm: (payload: T) => void
  /** Cancel without sending. */
  cancel: () => void
}

export function useHoldToSend<T>(
  send: (payload: T) => void | Promise<void>,
  holdMs: number = HOLD_MS,
): HoldToSend<T> {
  const [state, setState] = useState({ armed: false, secondsLeft: Math.ceil(holdMs / 1000) })

  // The latest send handler, so a fire scheduled several renders ago still calls the
  // current one rather than a stale closure.
  const sendRef = useRef(send)
  useEffect(() => {
    sendRef.current = send
  }, [send])

  const controller = useMemo(
    () =>
      new HoldController<T>(
        {
          send: (payload) => void sendRef.current(payload),
          onChange: setState,
        },
        holdMs,
      ),
    [holdMs],
  )

  // Never leave a hold running against an unmounted panel — that would send a message
  // the staff member can no longer see.
  useEffect(() => () => controller.dispose(), [controller])

  return {
    armed: state.armed,
    secondsLeft: state.secondsLeft,
    arm: (payload: T) => controller.arm(payload),
    cancel: () => controller.cancel(),
  }
}
