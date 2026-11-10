import type { ScanLook } from '@/lib/scan/enhance'
import type { Quad } from '@/lib/scan/geometry'

/** One page of a scan while it is being made. */
export interface ScanPage {
  id: string
  /** The photo as taken (a JPEG, at most 2400 pixels on the long side). The corners are in ITS pixels. */
  original: Blob
  width: number
  height: number
  corners: Quad
  look: ScanLook
  /** Web address of the straightened, cleaned-up small picture shown on screen. Released when the page goes. */
  previewUrl: string
}

export type ScanScreen = 'camera' | 'adjust' | 'pages'
