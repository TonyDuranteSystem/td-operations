import { useEffect, useState } from 'react'
import { usableVisibleHeight } from '@/lib/portal-chats/composer-height'

/**
 * The height of what the person can actually see right now, in px (null until measured, and always null when `enabled` is false).
 * Uses the browser's visual viewport, which shrinks when the keyboard opens even if the page itself keeps its full height, and falls
 * back to the window height. Rounded to 10 px so a sliding keyboard does not redraw the page on every pixel.
 */
export function useVisibleHeight(enabled: boolean): number | null {
  const [height, setHeight] = useState<number | null>(null)

  useEffect(() => {
    if (!enabled) {
      setHeight(null)
      return
    }
    const vv = window.visualViewport
    const read = () => {
      // a zero / missing reading (page hidden, not laid out yet) says nothing about the screen: keep the last good value instead of squeezing the box
      const usable = usableVisibleHeight(vv?.height ?? window.innerHeight)
      if (usable !== null) setHeight(usable)
    }
    read()
    vv?.addEventListener('resize', read)
    window.addEventListener('resize', read)
    return () => {
      vv?.removeEventListener('resize', read)
      window.removeEventListener('resize', read)
    }
  }, [enabled])

  return height
}
