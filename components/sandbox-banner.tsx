export function SandboxBanner() {
  if (process.env.SANDBOX_MODE !== '1') return null
  // Compact top-center pill (not a full-width bar): clearly marks sandbox
  // without covering the top content row. pointer-events-none so it never
  // intercepts clicks. Rendered once, from the root layout only.
  return (
    <div className="fixed top-1.5 left-1/2 -translate-x-1/2 z-50 pointer-events-none select-none rounded-full bg-orange-500/90 text-white px-3 py-0.5 text-[11px] font-semibold tracking-wide shadow-sm">
      ⚠ SANDBOX — NOT PRODUCTION
    </div>
  )
}
