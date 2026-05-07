import { describe, it, expect } from 'vitest'
import { resolveDriveFolderUrl } from '@/lib/drive-folder-url'

describe('resolveDriveFolderUrl', () => {
  it('returns the explicit gdrive_folder_url when present', () => {
    expect(
      resolveDriveFolderUrl('https://drive.google.com/drive/folders/AAA', 'BBB'),
    ).toBe('https://drive.google.com/drive/folders/AAA')
  })

  it('builds a URL from drive_folder_id when only the id is set', () => {
    expect(resolveDriveFolderUrl(null, 'BBB')).toBe(
      'https://drive.google.com/drive/folders/BBB',
    )
  })

  it('builds a URL from drive_folder_id when gdrive_folder_url is empty string', () => {
    // Empty string is falsy and should not be treated as a usable URL
    expect(resolveDriveFolderUrl('', 'CCC')).toBe(
      'https://drive.google.com/drive/folders/CCC',
    )
  })

  it('returns null when both columns are null', () => {
    expect(resolveDriveFolderUrl(null, null)).toBeNull()
  })

  it('returns null when both columns are undefined', () => {
    expect(resolveDriveFolderUrl(undefined, undefined)).toBeNull()
  })

  it('returns null when both columns are empty string / null', () => {
    expect(resolveDriveFolderUrl('', null)).toBeNull()
  })
})
