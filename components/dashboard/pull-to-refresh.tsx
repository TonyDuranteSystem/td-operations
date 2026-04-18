'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Loader2 } from 'lucide-react'

const THRESHOLD = 80
const MAX_PULL = 120

/**
 * Pull-to-refresh for the CRM dashboard PWA.
 * Attaches touch events to the <main> element for iOS Safari compatibility.
 */
export function DashboardPullToRefresh() {
  const router = useRouter()
  const pathname = usePathname()
  const [pullDistance, setPullDistance] = useState(0)
  const [refreshing, setRefreshing] = useState(false)

  const startYRef = useRef<number | null>(null)
  const pullingRef = useRef(false)
  const pullDistanceRef = useRef(0)
  const refreshingRef = useRef(false)

  useEffect(() => {
    // Portal-chats has its own inner scrolls — PTR conflicts with them.
    if (pathname === '/portal-chats') return

    const scrollEl = document.querySelector('main') as HTMLElement | null
    if (!scrollEl) return

    const onTouchStart = (e: TouchEvent) => {
      if (scrollEl.scrollTop > 0) return
      // If the touch started inside a nested scrollable element (e.g. the
      // messages list), don't intercept — let that element own the gesture.
      // Without this, the passive:false touchmove handler calls e.preventDefault()
      // on every downward drag when main.scrollTop===0, cancelling inner scrolls.
      let el = e.target as HTMLElement | null
      while (el && el !== scrollEl) {
        const oy = window.getComputedStyle(el).overflowY
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
          return
        }
        el = el.parentElement
      }
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

      e.preventDefault()
      pullingRef.current = true

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
    scrollEl.addEventListener('touchmove', onTouchMove, { passive: false })
    scrollEl.addEventListener('touchend', onTouchEnd, { passive: true })

    return () => {
      scrollEl.removeEventListener('touchstart', onTouchStart)
      scrollEl.removeEventListener('touchmove', onTouchMove)
      scrollEl.removeEventListener('touchend', onTouchEnd)
    }
  }, [router, pathname])

  const visible = pullDistance > 0 || refreshing
  const progress = Math.min(pullDistance / THRESHOLD, 1)
  const triggered = pullDistance >= THRESHOLD || refreshing

  if (!visible || pathname === '/portal-chats') return null

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex justify-center pointer-events-none"
      style={{
        transform: `translateY(${refreshing ? 12 : pullDistance * 0.4}px)`,
        transition: refreshing ? 'none' : 'transform 0.15s ease-out',
      }}
    >
      <div
        className="flex items-center justify-center w-10 h-10 rounded-full bg-white shadow-md border border-zinc-200"
        style={{ opacity: progress }}
      >
        <Loader2
          className={`h-5 w-5 text-red-600 ${triggered ? 'animate-spin' : ''}`}
          style={!triggered ? { transform: `rotate(${progress * 270}deg)`, transition: 'none' } : undefined}
        />
      </div>
    </div>
  )
}
