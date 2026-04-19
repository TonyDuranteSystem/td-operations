export function SandboxBanner() {
  if (process.env.SANDBOX_MODE !== '1') return null
  return (
    <div className="fixed top-0 left-0 right-0 z-50 bg-orange-500 text-white text-center py-2 px-4 font-bold text-sm pointer-events-none">
      ⚠️ SANDBOX ENVIRONMENT — NOT PRODUCTION ⚠️
    </div>
  )
}
