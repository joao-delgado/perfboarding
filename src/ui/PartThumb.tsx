import { boundsOf } from '../model/geometry'
import { sampleOutline } from '../model/shapes'
import type { PartDef } from '../model/types'
import { PartGraphics } from './PartGraphics'

/**
 * A part definition drawn to fit a box, used by the Library cards and the
 * Components rows. The viewBox is the artwork's own bounds plus a margin, so
 * `preserveAspectRatio` alone does the scaling — no zoom maths per call site.
 */
export function PartThumb({
  def,
  assetUrls,
  width,
  height,
  idPrefix = 'thumb',
}: {
  def: PartDef
  assetUrls: Record<string, string>
  width: number
  height: number
  idPrefix?: string
}) {
  const b = boundsOf([...sampleOutline(def.outline), ...def.pins])
  const pad = 0.6
  const w = Math.max(0.5, b.maxX - b.minX) + pad * 2
  const h = Math.max(0.5, b.maxY - b.minY) + pad * 2
  return (
    <svg
      viewBox={`${b.minX - pad} ${b.minY - pad} ${w} ${h}`}
      width={width}
      height={height}
      preserveAspectRatio="xMidYMid meet"
      style={{ display: 'block' }}
    >
      <PartGraphics def={def} idPrefix={`${idPrefix}-${def.id}`} assetUrls={assetUrls} />
      {def.pins.map((p) => (
        <circle key={p.id} cx={p.x} cy={p.y} r={0.18} fill="#ddd" stroke="#666" strokeWidth={0.08} />
      ))}
    </svg>
  )
}
