'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

const THRESHOLD = 80  // px to pull before triggering refresh
const MAX_PULL = 120  // px max visual pull distance

export function PullToRefresh() {
  const router = useRouter()
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  // Refs so event handlers always see current values without re-registering
  const startYRef = useRef<number | null>(null)
  const pullingRef = useRef(false)
  const pullDistanceRef = useRef(0)
  const refreshingRef = useRef(false)

  useEffect(() => {
    // Attach directly to the scrollable container (the portal main element).
    // This is required on iOS Safari: addEventListener on `document` with
    // passive:false still can't reliably cancel the browser's elastic-scroll
    // bounce when the touch target is a scrolling child element. Attaching to
    // the element itself gives us a reliable passive:false touchmove that
    // actually calls preventDefault() before the browser starts its bounce.
    const scrollEl = document.querySelector('main') as HTMLElement | null
    if (!scrollEl) return

    const onTouchStart = (e: TouchEvent) => {
      if (scrollEl.scrollTop > 0) return
      startYRef.current = e.touches[0].clientY
      pullingRef.current = false
    }

    const onTouchMove = (e: TouchEvent) => {
      if (startYRef.current === null || refreshingRef.current) return
      if (scrollEl.scrollTop > 0) {
        startYRef.current = null
        return
      }

      const deltaY = e.touches[0].clientY - startYRef.current
      if (deltaY <= 0) {
        startYRef.current = null
        return
      }

      // Prevent the browser's native pull-to-refresh / elastic-scroll
      e.preventDefault()
      pullingRef.current = true

      // Rubber-band resistance: pull decays as distance increases
      const capped = Math.min(deltaY * 0.5, MAX_PULL)
      pullDistanceRef.current = capped
      setPullDistance(capped)
    }

    const onTouchEnd = () => {
      if (!pullingRef.current) return

      if (pullDistanceRef.current >= THRESHOLD && !refreshingRef.current) {
        refreshingRef.current = true
        setRefreshing(true)
        router.refresh()
        // Hide indicator after refresh completes (~1.5s)
        setTimeout(() => {
          refreshingRef.current = false
          pullDistanceRef.current = 0
          setRefreshing(false)
          setPullDistance(0)
        }, 1500)
      } else {
        pullDistanceRef.current = 0
        setPullDistance(0)
      }

      startYRef.current = null
      pullingRef.current = false
    }

    scrollEl.addEventListener('touchstart', onTouchStart, { passive: true })
    // passive: false required so e.preventDefault() actually works
    scrollEl.addEventListener('touchmove', onTouchMove, { passive: false })
    scrollEl.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      scrollEl.removeEventListener('touchstart', onTouchStart)
      scrollEl.removeEventListener('touchmove', onTouchMove)
      scrollEl.removeEventListener('touchend', onTouchEnd)
    }
  }, [router])

  const visible = pullDistance > 0 || refreshing
  const progress = Math.min(pullDistance / THRESHOLD, 1)
  const triggered = pullDistance >= THRESHOLD || refreshing

  if (!visible) return null

  return (
    <div
      className="fixed top-14 left-0 right-0 z-50 flex justify-center pointer-events-none lg:top-0"
      style={{ transform: `translateY(${refreshing ? 12 : pullDistance * 0.4}px)`, transition: refreshing ? 'none' : 'transform 0.15s ease-out' }}
    >
      <div
        className="flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-md border border-zinc-200"
        style={{ opacity: progress }}
      >
        <Loader2
          className={`h-5 w-5 text-blue-600 ${triggered ? 'animate-spin' : ''}`}
          style={!triggered ? { transform: `rotate(${progress * 270}deg)`, transition: 'none' } : undefined}
        />
      </div>
    </div>
  )
}
