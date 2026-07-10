'use client'

/**
 * Full-panel drop target for the CRM worker panels.
 *
 * The composer alone is a bad drop target: it's a thin strip at the bottom, and
 * a file dropped anywhere else lands on the document, where the browser's
 * default is to NAVIGATE to it — the staff member loses the page. So the whole
 * panel accepts the drop, and the whole panel says so while you're dragging.
 */

import { useCallback, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WorkerDropZoneProps {
  onFiles: (files: File[]) => void
  disabled?: boolean
  className?: string
  children: React.ReactNode
}

/** Is this drag carrying files, as opposed to selected text or a link? */
function isFileDrag(e: React.DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

export function WorkerDropZone({ onFiles, disabled, className, children }: WorkerDropZoneProps) {
  const [dragging, setDragging] = useState(false)
  // dragenter/dragleave fire for every child element the cursor crosses. Counting
  // them is the only reliable way to know when the cursor has truly left the panel
  // — otherwise the overlay flickers as you move over the messages.
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setDragging(false)
  }, [])

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !isFileDrag(e)) return
      e.preventDefault()
      depth.current += 1
      setDragging(true)
    },
    [disabled],
  )

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!isFileDrag(e)) return
    e.preventDefault()
    depth.current -= 1
    if (depth.current <= 0) reset()
  }, [reset])

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !isFileDrag(e)) return
      // Required: without preventDefault on dragover the drop event never fires
      // and the browser opens the file instead.
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [disabled],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !isFileDrag(e)) return
      e.preventDefault()
      reset()
      const dropped = Array.from(e.dataTransfer?.files ?? [])
      if (dropped.length) onFiles(dropped)
    },
    [disabled, onFiles, reset],
  )

  return (
    <div
      className={cn('relative', className)}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
      {dragging && (
        <div className="absolute inset-0 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-violet-400 bg-violet-50/90 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-violet-700">
            <Upload className="h-7 w-7" />
            <p className="text-sm font-medium">Drop the file for the worker to read</p>
          </div>
        </div>
      )}
    </div>
  )
}
