export function SandboxBanner() {
  if (process.env.SANDBOX_MODE !== '1') return null
  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-orange-500 text-white text-center py-px px-3 font-medium text-[10px] leading-tight tracking-wide pointer-events-none">
      ⚠️ SANDBOX — NOT PRODUCTION
    </div>
  )
}
