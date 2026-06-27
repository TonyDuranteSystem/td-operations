"use client"

/**
 * Signature/initials capture. Reuses the signature_pad init pattern from the
 * existing signing page (devicePixelRatio scaling + touch-none). Returns a PNG
 * data URL.
 */

import { useCallback, useEffect, useRef, useState } from "react"

export function SignaturePadModal({
  title = "Draw your signature",
  onClose,
  onDone,
}: {
  title?: string
  onClose: () => void
  onDone: (dataUrl: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const padRef = useRef<InstanceType<typeof import("signature_pad").default> | null>(null)
  const [empty, setEmpty] = useState(true)

  useEffect(() => {
    let active = true
    async function init() {
      const SignaturePad = (await import("signature_pad")).default
      const canvas = canvasRef.current
      if (!canvas || !active) return
      const ratio = Math.max(window.devicePixelRatio || 1, 1)
      canvas.width = canvas.offsetWidth * ratio
      canvas.height = canvas.offsetHeight * ratio
      const ctx = canvas.getContext("2d")
      if (ctx) ctx.scale(ratio, ratio)
      const pad = new SignaturePad(canvas, { penColor: "rgb(0, 0, 100)", minWidth: 0.6, maxWidth: 2.6 })
      pad.addEventListener("endStroke", () => setEmpty(pad.isEmpty()))
      padRef.current = pad
    }
    const t = setTimeout(init, 50)
    return () => {
      active = false
      clearTimeout(t)
    }
  }, [])

  const clear = useCallback(() => {
    padRef.current?.clear()
    setEmpty(true)
  }, [])

  const apply = useCallback(() => {
    const pad = padRef.current
    if (!pad || pad.isEmpty()) return
    onDone(pad.toDataURL("image/png"))
  }, [onDone])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h3 className="text-base font-semibold text-zinc-900">{title}</h3>
        <div className="mt-3 rounded-lg border-2 border-dashed border-zinc-300 bg-zinc-50">
          <canvas ref={canvasRef} className="w-full touch-none" style={{ height: 160 }} />
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button onClick={clear} className="text-sm text-zinc-500 underline hover:text-zinc-700">
            Clear
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md border px-4 py-2 text-sm">
              Cancel
            </button>
            <button onClick={apply} disabled={empty} className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Apply
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
