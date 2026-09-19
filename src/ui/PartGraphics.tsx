/**
 * The drawn part: body (every sub-shape unioned into one outline), backdrop
 * image and vector artwork.
 *
 * Everything here is in PART-LOCAL coordinates. Callers put it inside whatever
 * transform they need — `partTransform(inst)` on the board, nothing at all in
 * the part editor — which is why a rotated part's artwork now rotates with it.
 */

import type { ArtShape, Artwork, PartDef } from '../model/types'
import { artShapeD, artTransform, outlineFillD } from './svgPath'

export function ArtShapeView({ shape, opacity = 1 }: { shape: ArtShape; opacity?: number }) {
  const o = shape.opacity * opacity
  const fill = shape.fill || 'none'
  const stroke = shape.stroke || 'none'
  const sw = shape.strokeWidth
  const body = (() => {
    switch (shape.kind) {
      case 'rect':
        return (
          <rect
            x={-shape.w / 2}
            y={-shape.h / 2}
            width={shape.w}
            height={shape.h}
            rx={shape.radius || undefined}
            ry={shape.radius || undefined}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
          />
        )
      case 'ellipse':
        return <ellipse rx={shape.rx} ry={shape.ry} fill={fill} stroke={stroke} strokeWidth={sw} />
      case 'path':
        return (
          <path
            d={artShapeD(shape)}
            fill={shape.closed ? fill : 'none'}
            stroke={stroke}
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )
      case 'text':
        return (
          <text
            textAnchor={shape.align}
            dominantBaseline="central"
            fontSize={shape.fontSize}
            fontFamily={shape.fontFamily}
            fontWeight={shape.bold ? 700 : 400}
            fontStyle={shape.italic ? 'italic' : 'normal'}
            fill={fill}
            stroke={stroke}
            strokeWidth={sw}
            // Stroke behind fill, so an outline reads as an outline rather
            // than eating half the glyph weight.
            paintOrder="stroke"
          >
            {shape.text}
          </text>
        )
    }
  })()
  return (
    <g transform={artTransform(shape)} opacity={o}>
      {body}
    </g>
  )
}

export function ArtLayer({
  artwork,
  clipId,
  opacity = 1,
}: {
  artwork: Artwork
  clipId?: string
  opacity?: number
}) {
  return (
    <g clipPath={clipId ? `url(#${clipId})` : undefined} pointerEvents="none">
      {artwork.shapes.map((s) => (s.hidden ? null : <ArtShapeView key={s.id} shape={s} opacity={opacity} />))}
    </g>
  )
}

interface Props {
  def: PartDef
  /** Unique per rendered instance: clipPath ids are document-global. */
  idPrefix: string
  assetUrls?: Record<string, string>
  /** Ghosting multiplier, applied on top of each element's own opacity. */
  opacity?: number
  selected?: boolean
  /** SVG filter reference for the drop shadow, where one is defined. */
  filter?: string
  /** Suppress the artwork and backdrop — used by the drop preview. */
  bodyOnly?: boolean
}

export function PartGraphics({
  def,
  idPrefix,
  assetUrls,
  opacity = 1,
  selected = false,
  filter,
  bodyOnly = false,
}: Props) {
  const fillD = outlineFillD(def.outline)
  const clipId = `${idPrefix}-body`
  const texUrl = def.texture && assetUrls ? assetUrls[def.texture.assetId] : undefined
  const clipsToBody =
    !!fillD && ((def.texture?.clipToOutline ?? false) || (def.artwork?.clipToOutline ?? false))

  return (
    <>
      {clipsToBody && (
        <defs>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <path d={fillD} clipRule="evenodd" />
          </clipPath>
        </defs>
      )}

      {fillD && (
        <path
          d={fillD}
          fillRule="evenodd"
          fill={def.fill}
          stroke={selected ? '#1E88E5' : def.stroke}
          strokeWidth={selected ? 0.12 : 0.06}
          strokeLinejoin="round"
          opacity={opacity}
          filter={filter}
        />
      )}

      {!bodyOnly && def.texture && texUrl && (
        <image
          href={texUrl}
          x={def.texture.x}
          y={def.texture.y}
          width={def.texture.w}
          height={def.texture.h}
          opacity={def.texture.opacity * opacity}
          clipPath={def.texture.clipToOutline && clipsToBody ? `url(#${clipId})` : undefined}
          preserveAspectRatio="none"
          pointerEvents="none"
        />
      )}

      {!bodyOnly && def.artwork && def.artwork.shapes.length > 0 && (
        <ArtLayer
          artwork={def.artwork}
          clipId={def.artwork.clipToOutline && clipsToBody ? clipId : undefined}
          opacity={opacity}
        />
      )}
    </>
  )
}
