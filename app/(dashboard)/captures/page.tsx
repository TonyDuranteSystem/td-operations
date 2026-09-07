'use client'

/**
 * "My Captures" — a real, linkable page. Antonio normally reaches this
 * content through the top-bar "My captures" popup instead (opens over
 * whatever page he's on, see components/captures/my-captures-overlay.tsx) —
 * this page stays for direct navigation/bookmarking, both rendering the
 * SAME MyCapturesPanel so the two never drift.
 */
import { MyCapturesPanel } from '@/components/captures/my-captures-panel'

export default function CapturesPage() {
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <h1 className="text-xl font-semibold text-zinc-900">My Captures</h1>
      <p className="mt-1 text-sm text-zinc-500">Every screenshot you have taken — only visible to you.</p>
      <div className="mt-4">
        <MyCapturesPanel />
      </div>
    </div>
  )
}
