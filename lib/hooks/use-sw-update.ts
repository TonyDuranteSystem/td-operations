'use client'

import { useEffect, useState, useCallback, useRef } from 'react'

const FORCE_UPDATE_KEY = 'sw_update_detected_at'
const FORCE_UPDATE_HOURS = 24

/**
 * Hook for detecting and applying service worker updates.
 * Shows "Update available" when a new SW is waiting, polls for updates every 60s.
 * Force-updates after 24h if user ignores the banner.
 */
export function useSwUpdate(swPath: string, scope?: string) {
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const regRef = useRef<ServiceWorkerRegistration | null>(null)

  const applyUpdate = useCallback(() => {
    const reg = regRef.current
    if (!reg?.waiting) return
    reg.waiting.postMessage({ type: 'SKIP_WAITING' })
  }, [])

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return

    let pollInterval: ReturnType<typeof setInterval> | null = null

    function onNewSWWaiting() {
      setUpdateAvailable(true)
      // Track when update was first detected (for force-update)
      if (!localStorage.getItem(FORCE_UPDATE_KEY)) {
        localStorage.setItem(FORCE_UPDATE_KEY, Date.now().toString())
      }
    }

    function checkForceUpdate() {
      const detectedAt = localStorage.getItem(FORCE_UPDATE_KEY)
      if (!detectedAt) return
      const hoursElapsed = (Date.now() - Number(detectedAt)) / (1000 * 60 * 60)
      if (hoursElapsed >= FORCE_UPDATE_HOURS) {
        localStorage.removeItem(FORCE_UPDATE_KEY)
        const reg = regRef.current
        if (reg?.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' })
        }
      }
    }

    function trackInstalling(worker: ServiceWorker) {
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          onNewSWWaiting()
        }
      })
    }

    navigator.serviceWorker
      .register(swPath, scope ? { scope } : undefined)
      .then((reg) => {
        regRef.current = reg

        // Check if there's already a waiting worker (from previous visit)
        if (reg.waiting) {
          onNewSWWaiting()
          checkForceUpdate()
        }

        // Listen for new updates
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing
          if (newWorker) {
            trackInstalling(newWorker)
          }
        })

        // Poll for updates every 60 seconds
        pollInterval = setInterval(() => {
          reg.update().catch(() => {})
        }, 60_000)
      })
      .catch(() => {
        // SW registration failed — non-critical
      })

    // Reload when new SW takes control
    let refreshing = false
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (refreshing) return
      refreshing = true
      localStorage.removeItem(FORCE_UPDATE_KEY)
      window.location.reload()
    })

    return () => {
      if (pollInterval) clearInterval(pollInterval)
    }
  }, [swPath, scope])

  return { updateAvailable, applyUpdate }
}
