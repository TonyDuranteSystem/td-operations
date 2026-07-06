import { describe, it, expect } from 'vitest'
import {
  GEOMETRY_SCHEMA_VERSION,
  GEOMETRY_PRESETS,
  GEOMETRY_PRESET_IDS,
  getGeometryPreset,
  clamp01,
  geometryFromPreset,
  defaultGeometry,
  withGeometryOverride,
  coerceGeometry,
  geometrySummary,
  cornerPathD,
  renderGeometrySvg,
  geometryFileName,
} from '@/lib/td-communication/geometry'

describe('presets + clamps', () => {
  it('registry ids are unique and all resolvable', () => {
    expect(new Set(GEOMETRY_PRESET_IDS).size).toBe(GEOMETRY_PRESETS.length)
    for (const id of GEOMETRY_PRESET_IDS) expect(getGeometryPreset(id)).toBeTruthy()
    expect(getGeometryPreset('nope')).toBeUndefined()
  })
  it('clamp01 bounds and rejects NaN/non-numbers', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01('x')).toBe(0)
    expect(clamp01(NaN)).toBe(0)
  })
})

describe('geometryFromPreset', () => {
  it('seeds normalized values, source=preset, derived set', () => {
    const g = geometryFromPreset('rounded')
    expect(g.schema_version).toBe(GEOMETRY_SCHEMA_VERSION)
    expect(g.preset_id).toBe('rounded')
    expect(g.source).toBe('preset')
    expect(g.derived_from_preset).toBe('rounded')
    expect(g.corner_radius).toBeGreaterThan(0)
    expect(g.corner_radius).toBeLessThanOrEqual(1)
  })
  it('unknown id falls back to the first preset', () => {
    expect(geometryFromPreset('bogus').preset_id).toBe(GEOMETRY_PRESETS[0].id)
  })
  it('default is rounded', () => {
    expect(defaultGeometry().preset_id).toBe('rounded')
  })
})

describe('withGeometryOverride — preset↔custom state machine', () => {
  it('a slider move flips source to custom but keeps derived_from_preset', () => {
    const base = geometryFromPreset('rounded')
    const edited = withGeometryOverride(base, { corner_radius: 0.9 })
    expect(edited.source).toBe('custom')
    expect(edited.derived_from_preset).toBe('rounded')
    expect(edited.corner_radius).toBe(0.9)
  })
  it('returning the value to the seed flips source back to preset', () => {
    const base = geometryFromPreset('rounded') // radius 0.35
    const moved = withGeometryOverride(base, { corner_radius: 0.9 })
    const back = withGeometryOverride(moved, { corner_radius: 0.35 })
    expect(back.source).toBe('preset')
  })
  it('clamps overrides into range', () => {
    const g = withGeometryOverride(geometryFromPreset('squared'), { corner_radius: 5, edge_sharpness: -3 })
    expect(g.corner_radius).toBe(1)
    expect(g.edge_sharpness).toBe(0)
  })
})

describe('coerceGeometry', () => {
  it('returns null for empty/garbage', () => {
    expect(coerceGeometry(null)).toBeNull()
    expect(coerceGeometry('x')).toBeNull()
    expect(coerceGeometry({})).toBeNull()
  })
  it('coerces a partial object without NaN', () => {
    const g = coerceGeometry({ preset_id: 'bevelled', corner_radius: 'bad', edge_sharpness: 2 })
    expect(g).not.toBeNull()
    expect(g!.preset_id).toBe('bevelled')
    expect(g!.corner_radius).toBe(0) // 'bad' → 0
    expect(g!.edge_sharpness).toBe(1) // 2 → clamped
    expect(g!.corner_style).toBe('bevel') // from the preset
  })
  it('defaults an unknown corner_style to round', () => {
    const g = coerceGeometry({ corner_radius: 0.5, corner_style: 'triangle' })
    expect(g!.corner_style).toBe('round')
  })
})

describe('cornerPathD', () => {
  it('square corners when radius is ~0', () => {
    expect(cornerPathD('round', 100, 80, 0, 0)).toBe('M0,0 H100 V80 H0 Z')
  })
  it('round style emits arc commands', () => {
    const d = cornerPathD('round', 200, 120, 30, 0)
    expect(d).toContain('A')
  })
  it('bevel style emits straight cut lines, no arcs', () => {
    const d = cornerPathD('bevel', 200, 120, 30, 0.5)
    expect(d).toContain('L')
    expect(d).not.toContain('A')
  })
  it('clamps the corner to at most half the shorter side', () => {
    // radius far bigger than the box → still a valid closed path, no runaway values
    const d = cornerPathD('round', 100, 60, 999, 0)
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
  })
})

describe('renderGeometrySvg', () => {
  it('produces a self-contained svg with the shaped path and brand fill', () => {
    const svg = renderGeometrySvg(geometryFromPreset('rounded'), { bg: '#123456', ink: '#000000' })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<path')
    expect(svg).toContain('#123456')
  })
  it('XML-escapes an injected label (no raw markup)', () => {
    const svg = renderGeometrySvg(defaultGeometry(), { label: '<script>alert(1)</script>' })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })
})

describe('geometrySummary + geometryFileName', () => {
  it('summary names the preset and marks custom', () => {
    expect(geometrySummary(geometryFromPreset('bevelled'))).toContain('Bevelled')
    const custom = withGeometryOverride(geometryFromPreset('rounded'), { corner_radius: 0.8 })
    expect(geometrySummary(custom)).toContain('custom')
  })
  it('file name is slugged and carries the preset + extension', () => {
    expect(geometryFileName('Acme Café!', geometryFromPreset('pill'), 'svg')).toBe('acme-cafe-geometry-pill.svg')
    const custom = withGeometryOverride(geometryFromPreset('rounded'), { corner_radius: 0.8 })
    expect(geometryFileName('X', custom, 'png')).toBe('x-geometry-rounded-custom.png')
  })
})
