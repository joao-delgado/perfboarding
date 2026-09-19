import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { assetUrl, putAsset } from '../io/assets'
import { ACCEPTED_IMAGE_TYPES, readImageFile } from '../io/sanitize'
import {
  boundsFromCorners,
  boundsOf,
  type Bounds,
  constrain8,
  MM_PER_HOLE,
  snapToStep,
} from '../model/geometry'
import {
  artCorners,
  artHit,
  artLocalBounds,
  artToPart,
  DEFAULT_LINE_WIDTH,
  emptyArtwork,
  lineNodes,
  makeArtEllipse,
  makeArtPath,
  makeArtRect,
  makeArtText,
  makeOutlineEllipse,
  makeOutlineLine,
  makeOutlinePath,
  makeOutlineRect,
  node,
  outlineIsEmpty,
  outlineShapeBounds,
  outlineShapeHit,
  outlineShapeLabel,
  partToArt,
  recentreArt,
  sampleOutline,
  setArtLocalBox,
  setOutlineShapeBox,
  translateOutlineShape,
} from '../model/shapes'
import type {
  ArtAlign,
  ArtShape,
  AssetMeta,
  Outline,
  OutlineShape,
  PartDef,
  PathNode,
  Vec,
} from '../model/types'
import { uid } from '../model/ids'
import { InfoTip } from './InfoTip'
import { LayersPanel, type LayerItem } from './LayersPanel'
import { PartGraphics } from './PartGraphics'
import { Ruler } from './Ruler'
import { nodesD } from './svgPath'
import { EllipseIcon, LineIcon, PenIcon, RectIcon, SelectIcon, TextIcon } from './ToolIcons'

type Mode = 'outline' | 'pins' | 'texture'
type OutlineTool = 'select' | 'pen' | 'line' | 'rect' | 'ellipse'
type ArtTool = 'select' | 'rect' | 'ellipse' | 'pen' | 'line' | 'text'
type Axis = 'both' | 'x' | 'y'

/** Screen px per hole at zoom 1. */
const CELL = 34
/** Width of the ruler strips along the top and left edges. */
const RULER = 22
/** Body geometry lives on half-hole steps — a real body edge falls between pin rows. */
const BODY_STEP = 0.5
/** Below this, a pen drag is a click: a corner, not a curve. */
const HANDLE_DEADZONE = 0.22

const FONTS = [
  ['Sans', 'ui-sans-serif, system-ui, sans-serif'],
  ['Serif', 'ui-serif, Georgia, serif'],
  ['Mono', 'ui-monospace, monospace'],
]

const mm = (holes: number) => holes * MM_PER_HOLE
const fmtMm = (holes: number) => `${mm(holes).toFixed(1)} mm`

function blankDef(): PartDef {
  return {
    id: uid('def'),
    name: 'New part',
    prefix: 'U',
    outline: { shapes: [] },
    pins: [],
    artwork: emptyArtwork(),
    fill: '#3B4A5A',
    stroke: '#20272F',
  }
}

interface Camera {
  /** Screen px position of the part's local origin. */
  x: number
  y: number
  zoom: number
}

type Drag =
  | { kind: 'none' }
  | { kind: 'pan'; lastScreen: Vec }
  | { kind: 'pin'; id: string }
  | { kind: 'node'; shapeId: string; index: number }
  | { kind: 'handle'; shapeId: string; index: number; which: 'hIn' | 'hOut'; mirror: boolean }
  | { kind: 'shapeMove'; shapeId: string; origin: Vec; start: OutlineShape }
  | { kind: 'shapeBox'; shapeId: string; fixed: Vec; axis: Axis }
  | { kind: 'shapeNew'; shapeId: string; origin: Vec }
  | { kind: 'lineNew'; shapeId: string; origin: Vec }
  | { kind: 'artMove'; id: string; origin: Vec; start: Vec }
  | { kind: 'artBox'; id: string; fixedPart: Vec; axis: Axis }
  | { kind: 'artRotate'; id: string; grabAngle: number; startRot: number }
  | { kind: 'artNode'; id: string; index: number }
  | { kind: 'artNew'; id: string; origin: Vec }

/** The eight box handles, as {where it is drawn, what stays put, what may move}. */
function boxHandles(b: Bounds): { at: Vec; fixed: Vec; axis: Axis }[] {
  const { minX, minY, maxX, maxY } = b
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return [
    { at: { x: minX, y: minY }, fixed: { x: maxX, y: maxY }, axis: 'both' },
    { at: { x: maxX, y: minY }, fixed: { x: minX, y: maxY }, axis: 'both' },
    { at: { x: maxX, y: maxY }, fixed: { x: minX, y: minY }, axis: 'both' },
    { at: { x: minX, y: maxY }, fixed: { x: maxX, y: minY }, axis: 'both' },
    { at: { x: cx, y: minY }, fixed: { x: cx, y: maxY }, axis: 'y' },
    { at: { x: maxX, y: cy }, fixed: { x: minX, y: cy }, axis: 'x' },
    { at: { x: cx, y: maxY }, fixed: { x: cx, y: minY }, axis: 'y' },
    { at: { x: minX, y: cy }, fixed: { x: maxX, y: cy }, axis: 'x' },
  ]
}

/** New box from a fixed anchor and a dragged point, keeping the locked axis. */
function boxFromDrag(current: Bounds, fixed: Vec, to: Vec, axis: Axis): Bounds {
  if (axis === 'x') return { minX: Math.min(fixed.x, to.x), maxX: Math.max(fixed.x, to.x), minY: current.minY, maxY: current.maxY }
  if (axis === 'y') return { minX: current.minX, maxX: current.maxX, minY: Math.min(fixed.y, to.y), maxY: Math.max(fixed.y, to.y) }
  return boundsFromCorners(fixed, to)
}

interface Props {
  initial?: PartDef
  assets?: Record<string, AssetMeta>
  onCancel: () => void
  onSave: (def: PartDef, assets: Record<string, AssetMeta>) => void
}

export function PartEditor({ initial, assets, onCancel, onSave }: Props) {
  const [def, setDef] = useState<PartDef>(() => (initial ? structuredClone(initial) : blankDef()))
  const [mode, setMode] = useState<Mode>('outline')
  const [outlineTool, setOutlineTool] = useState<OutlineTool>('pen')
  const [artTool, setArtTool] = useState<ArtTool>('select')
  const [cursor, setCursor] = useState<Vec | null>(null)
  const [selShape, setSelShape] = useState<string | null>(null)
  const [selNode, setSelNode] = useState<number | null>(null)
  const [selPin, setSelPin] = useState<string | null>(null)
  const [selArt, setSelArt] = useState<string | null>(null)
  const [penId, setPenId] = useState<string | null>(null)
  const [artPenId, setArtPenId] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag>({ kind: 'none' })
  const [newAssets, setNewAssets] = useState<Record<string, AssetMeta>>({})
  const [textBoxes, setTextBoxes] = useState<Record<string, Bounds>>({})
  const [error, setError] = useState('')
  const [size, setSize] = useState({ w: 900, h: 600 })
  const [cam, setCam] = useState<Camera>({ x: 200, y: 160, zoom: 1 })
  const hostRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const textEls = useRef(new Map<string, SVGTextElement>())
  const shiftRef = useRef(false)
  const lastDown = useRef<{ key: string; t: number } | null>(null)

  const scale = CELL * cam.zoom
  const shapes = def.outline.shapes
  const artwork = def.artwork ?? emptyArtwork()
  const artShapes = artwork.shapes
  const penShape = penId ? shapes.find((s) => s.id === penId) : undefined
  const selected = selShape ? shapes.find((s) => s.id === selShape) : undefined
  const selectedArt = selArt ? artShapes.find((s) => s.id === selArt) : undefined
  const measured = (s: ArtShape) => (s.kind === 'text' ? textBoxes[s.id] : undefined)

  // ---- camera -------------------------------------------------------------
  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fitTo = useCallback(
    (box: Bounds, w: number, h: number) => {
      const bw = Math.max(4, box.maxX - box.minX + 3)
      const bh = Math.max(3, box.maxY - box.minY + 3)
      // Capped: fitting a two-point sketch would otherwise open at 400%.
      const zoom = Math.max(0.25, Math.min(2, Math.min((w - RULER - 60) / (bw * CELL), (h - RULER - 60) / (bh * CELL))))
      const s = CELL * zoom
      return {
        zoom,
        x: RULER + (w - RULER - bw * s) / 2 - (box.minX - 1.5) * s,
        y: RULER + (h - RULER - bh * s) / 2 - (box.minY - 1.5) * s,
      }
    },
    [],
  )

  const artworkBounds = useCallback(
    (): Bounds => {
      const pts = [...sampleOutline(def.outline), ...def.pins]
      for (const s of artShapes) pts.push(...artCorners(s, measured(s)))
      return pts.length ? boundsOf(pts) : { minX: 0, minY: 0, maxX: 9, maxY: 6 }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [def.outline, def.pins, artShapes, textBoxes],
  )

  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || size.w < 50) return
    fitted.current = true
    setCam(fitTo(artworkBounds(), size.w, size.h))
    // Only the first measured size seeds the camera; after that it is the
    // user's to move, and re-fitting under the cursor is exactly the jump the
    // old grow-only extent existed to avoid.
  }, [size, fitTo, artworkBounds])

  const zoomAt = useCallback((c: Camera, at: Vec, factor: number): Camera => {
    const next = Math.max(0.2, Math.min(8, c.zoom * factor))
    const k = next / c.zoom
    return { zoom: next, x: at.x - (at.x - c.x) * k, y: at.y - (at.y - c.y) * k }
  }, [])

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const at = { x: e.clientX - r.left, y: e.clientY - r.top }
      setCam((c) =>
        e.ctrlKey || e.metaKey
          ? zoomAt(c, at, Math.exp(-e.deltaY / 100))
          : { ...c, x: c.x - e.deltaX, y: c.y - e.deltaY },
      )
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomAt])

  const toLocal = useCallback(
    (e: { clientX: number; clientY: number }): Vec => {
      const r = svgRef.current?.getBoundingClientRect()
      if (!r) return { x: 0, y: 0 }
      return { x: (e.clientX - r.left - cam.x) / scale, y: (e.clientY - r.top - cam.y) / scale }
    },
    [cam, scale],
  )
  const toScreen = useCallback(
    (p: Vec): Vec => ({ x: cam.x + p.x * scale, y: cam.y + p.y * scale }),
    [cam, scale],
  )

  /** Body geometry snaps to half holes; pins to whole ones; artwork not at all. */
  const snap = useCallback((p: Vec) => (mode === 'pins' ? snapToStep(p, 1) : snapToStep(p, BODY_STEP)), [mode])

  /** Our own double-click test — pointer capture retargets the browser's. */
  const doubleClicked = (key: string): boolean => {
    const now = performance.now()
    const prev = lastDown.current
    lastDown.current = { key, t: now }
    return !!prev && prev.key === key && now - prev.t < 400
  }

  const capture = (e: React.PointerEvent) => {
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // not fatal: the drag still works through bubbling
    }
  }

  // ---- measuring text -----------------------------------------------------
  // Text has no geometry we can compute: the box comes from the browser. The
  // measurement only ever drives selection handles, never rendering, so the
  // board and the editor cannot disagree about where a label sits.
  const textKey = artShapes
    .filter((s) => s.kind === 'text')
    .map((s) => (s.kind === 'text' ? `${s.id}:${s.text}:${s.fontSize}:${s.fontFamily}:${s.bold}:${s.italic}:${s.align}` : ''))
    .join('|')

  useLayoutEffect(() => {
    const next: Record<string, Bounds> = {}
    for (const [id, el] of textEls.current) {
      try {
        const b = el.getBBox()
        next[id] = { minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height }
      } catch {
        // getBBox throws on a detached node; the estimate covers it
      }
    }
    setTextBoxes((prev) => {
      const same =
        Object.keys(prev).length === Object.keys(next).length &&
        Object.entries(next).every(([k, v]) => {
          const p = prev[k]
          return p && Math.abs(p.minX - v.minX) < 1e-6 && Math.abs(p.minY - v.minY) < 1e-6 && Math.abs(p.maxX - v.maxX) < 1e-6 && Math.abs(p.maxY - v.maxY) < 1e-6
        })
      return same ? prev : next
    })
  }, [textKey])

  // ---- model edits --------------------------------------------------------
  const setOutline = (f: (o: Outline) => Outline) => setDef((d) => ({ ...d, outline: f(d.outline) }))

  const putShape = (id: string, f: (s: OutlineShape) => OutlineShape) =>
    setOutline((o) => ({ ...o, shapes: o.shapes.map((s) => (s.id === id ? f(s) : s)) }))

  const dropShape = (id: string) => {
    setOutline((o) => ({ ...o, shapes: o.shapes.filter((s) => s.id !== id) }))
    if (selShape === id) setSelShape(null)
    if (penId === id) setPenId(null)
    setSelNode(null)
  }

  const setArtwork = (f: (a: typeof artwork) => typeof artwork) =>
    setDef((d) => ({ ...d, artwork: f(d.artwork ?? emptyArtwork()) }))

  const putArt = (id: string, f: (s: ArtShape) => ArtShape) =>
    setArtwork((a) => ({ ...a, shapes: a.shapes.map((s) => (s.id === id ? f(s) : s)) }))

  const addArt = (s: ArtShape) => {
    setArtwork((a) => ({ ...a, shapes: [...a.shapes, s] }))
    setSelArt(s.id)
  }

  const dropArt = (id: string) => {
    setArtwork((a) => ({ ...a, shapes: a.shapes.filter((s) => s.id !== id) }))
    if (selArt === id) setSelArt(null)
    if (artPenId === id) setArtPenId(null)
    setSelNode(null)
  }

  /** Finish the open pen run: close it into a body, or leave it as a lead. */
  const finishPen = useCallback(
    (close: boolean) => {
      if (!penId) return
      const s = shapes.find((x) => x.id === penId)
      setPenId(null)
      if (!s || s.kind !== 'path') return
      // There is no "open shape" to fall back to any more — a pen run that
      // never closes into a real body isn't kept at all.
      if (!close || s.nodes.length < 3) {
        dropShape(penId)
        return
      }
      putShape(penId, (x) => (x.kind === 'path' ? { ...x, closed: true } : x))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [penId, shapes],
  )

  const finishArtPen = useCallback(
    (close: boolean) => {
      if (!artPenId) return
      const s = artShapes.find((x) => x.id === artPenId)
      setArtPenId(null)
      if (!s || s.kind !== 'path') return
      if (s.nodes.length < 2) {
        dropArt(artPenId)
        return
      }
      putArt(artPenId, (x) => (x.kind === 'path' ? recentreArt({ ...x, closed: close && x.nodes.length >= 3 }) : x))
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [artPenId, artShapes],
  )

  // Switching mode or tool must never leave a half-drawn path behind.
  useEffect(() => {
    if (mode !== 'outline' || outlineTool !== 'pen') finishPen(true)
    if (mode !== 'texture' || (artTool !== 'pen' && artTool !== 'line')) finishArtPen(artTool === 'pen')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, outlineTool, artTool])

  // ---- pointer ------------------------------------------------------------
  function onPointerDown(e: React.PointerEvent) {
    if (e.button === 1 || e.altKey) {
      capture(e)
      setDrag({ kind: 'pan', lastScreen: { x: e.clientX, y: e.clientY } })
      return
    }
    if (e.button !== 0) return
    const raw = toLocal(e)
    setError('')
    const grab = 8 / scale

    if (mode === 'pins') return onPinsDown(e, raw, grab)
    if (mode === 'outline') return onOutlineDown(e, raw, grab)
    return onArtDown(e, raw, grab)
  }

  function onPinsDown(e: React.PointerEvent, raw: Vec, grab: number) {
    const p = snapToStep(raw, 1)
    const hit = def.pins.find((q) => Math.hypot(q.x - raw.x, q.y - raw.y) < Math.max(0.4, grab))
    if (hit) {
      if (doubleClicked(`pin:${hit.id}`)) {
        setDef((d) => ({ ...d, pins: d.pins.filter((q) => q.id !== hit.id) }))
        setSelPin(null)
        return
      }
      setSelPin(hit.id)
      capture(e)
      setDrag({ kind: 'pin', id: hit.id })
      return
    }
    const pin = { id: uid('pin'), name: String(def.pins.length + 1), x: p.x, y: p.y }
    setDef((d) => ({ ...d, pins: [...d.pins, pin] }))
    setSelPin(pin.id)
    capture(e)
    setDrag({ kind: 'pin', id: pin.id })
  }

  function onOutlineDown(e: React.PointerEvent, raw: Vec, grab: number) {
    const p = penPoint(raw)

    if (outlineTool === 'pen') {
      if (penShape && penShape.kind === 'path') {
        const first = penShape.nodes[0]
        if (penShape.nodes.length >= 3 && Math.hypot(first.x - raw.x, first.y - raw.y) <= grab) {
          finishPen(true)
          return
        }
        const last = penShape.nodes[penShape.nodes.length - 1]
        if (Math.hypot(last.x - p.x, last.y - p.y) < 1e-6) return
        const index = penShape.nodes.length
        putShape(penShape.id, (s) => (s.kind === 'path' ? { ...s, nodes: [...s.nodes, node(p.x, p.y)] } : s))
        setSelNode(index)
        capture(e)
        setDrag({ kind: 'handle', shapeId: penShape.id, index, which: 'hOut', mirror: true })
        return
      }
      const shape = makeOutlinePath([node(p.x, p.y)], false)
      setOutline((o) => ({ ...o, shapes: [...o.shapes, shape] }))
      setPenId(shape.id)
      setSelShape(shape.id)
      setSelNode(0)
      capture(e)
      setDrag({ kind: 'handle', shapeId: shape.id, index: 0, which: 'hOut', mirror: true })
      return
    }

    // Line: a drag-create tool like Rect/Ellipse, not a pen run. What it makes
    // is a thin filled rectangle — a shape like any other, unioned into the
    // body the same way — not a stroked open path.
    if (outlineTool === 'line') {
      const shape = makeOutlineLine(p, p, DEFAULT_LINE_WIDTH)
      setOutline((o) => ({ ...o, shapes: [...o.shapes, shape] }))
      setSelShape(shape.id)
      setSelNode(null)
      capture(e)
      setDrag({ kind: 'lineNew', shapeId: shape.id, origin: p })
      return
    }

    if (outlineTool === 'rect' || outlineTool === 'ellipse') {
      const shape =
        outlineTool === 'rect' ? makeOutlineRect(p.x, p.y, 0, 0) : makeOutlineEllipse(p.x, p.y, 0, 0)
      setOutline((o) => ({ ...o, shapes: [...o.shapes, shape] }))
      setSelShape(shape.id)
      setSelNode(null)
      capture(e)
      setDrag({ kind: 'shapeNew', shapeId: shape.id, origin: p })
      return
    }

    // --- select tool: nodes, then handles, then the box, then the body.
    if (selected) {
      if (selected.kind === 'path') {
        if (selNode !== null && selNode < selected.nodes.length) {
          const n = selected.nodes[selNode]
          for (const which of ['hIn', 'hOut'] as const) {
            const h = n[which]
            if (h && Math.hypot(h.x - raw.x, h.y - raw.y) <= grab) {
              capture(e)
              setDrag({ kind: 'handle', shapeId: selected.id, index: selNode, which, mirror: false })
              return
            }
          }
        }
        const vi = selected.nodes.findIndex((q) => Math.hypot(q.x - raw.x, q.y - raw.y) <= grab)
        if (vi >= 0) {
          if (doubleClicked(`v:${selected.id}:${vi}`)) {
            removeNode(selected.id, vi)
            return
          }
          setSelNode(vi)
          capture(e)
          setDrag({ kind: 'node', shapeId: selected.id, index: vi })
          return
        }
        const mid = midpoints.find((m) => Math.hypot(m.at.x - raw.x, m.at.y - raw.y) <= grab)
        if (mid) {
          const at = snap(mid.at)
          putShape(selected.id, (s) =>
            s.kind === 'path' ? { ...s, nodes: [...s.nodes.slice(0, mid.index), node(at.x, at.y), ...s.nodes.slice(mid.index)] } : s,
          )
          setSelNode(mid.index)
          capture(e)
          setDrag({ kind: 'node', shapeId: selected.id, index: mid.index })
          return
        }
      }
      const handle = boxHandles(outlineShapeBounds(selected)).find((h) => Math.hypot(h.at.x - raw.x, h.at.y - raw.y) <= grab)
      if (handle) {
        capture(e)
        setDrag({ kind: 'shapeBox', shapeId: selected.id, fixed: handle.fixed, axis: handle.axis })
        return
      }
    }

    // Topmost first: the last shape drawn is the one on top.
    const hit = [...shapes].reverse().find((s) => !s.hidden && outlineShapeHit(s, raw, grab))
    if (hit) {
      setSelShape(hit.id)
      setSelNode(null)
      capture(e)
      setDrag({ kind: 'shapeMove', shapeId: hit.id, origin: raw, start: hit })
      return
    }
    setSelShape(null)
    setSelNode(null)
  }

  function onArtDown(e: React.PointerEvent, raw: Vec, grab: number) {
    if (artTool === 'text') {
      addArt(makeArtText(raw.x, raw.y, 'Text', def.stroke === '#000000' ? '#FFFFFF' : '#FFFFFF'))
      setArtTool('select')
      return
    }

    if (artTool === 'pen' || artTool === 'line') {
      const pen = artPenId ? artShapes.find((s) => s.id === artPenId) : undefined
      if (pen && pen.kind === 'path') {
        const first = artToPart(pen, pen.nodes[0])
        if (artTool === 'pen' && pen.nodes.length >= 3 && Math.hypot(first.x - raw.x, first.y - raw.y) <= grab) {
          finishArtPen(true)
          return
        }
        const local = partToArt(pen, raw)
        const index = pen.nodes.length
        putArt(pen.id, (s) => (s.kind === 'path' ? { ...s, nodes: [...s.nodes, node(local.x, local.y)] } : s))
        setSelNode(index)
        capture(e)
        setDrag({ kind: 'handle', shapeId: pen.id, index, which: 'hOut', mirror: true })
        return
      }
      const shape = makeArtPath([node(raw.x, raw.y)], false, '#FFFFFF', '#FFFFFF')
      addArt(shape)
      setArtPenId(shape.id)
      setSelNode(0)
      capture(e)
      setDrag({ kind: 'handle', shapeId: shape.id, index: 0, which: 'hOut', mirror: true })
      return
    }

    if (artTool === 'rect' || artTool === 'ellipse') {
      const shape =
        artTool === 'rect'
          ? makeArtRect(raw.x, raw.y, 0, 0, '#FFFFFF', 'none')
          : makeArtEllipse(raw.x, raw.y, 0, 0, '#FFFFFF', 'none')
      addArt(shape)
      capture(e)
      setDrag({ kind: 'artNew', id: shape.id, origin: raw })
      return
    }

    // --- select tool
    if (selectedArt && !selectedArt.locked) {
      const b = artLocalBounds(selectedArt, measured(selectedArt))
      const rotAt = artToPart(selectedArt, { x: (b.minX + b.maxX) / 2, y: b.minY - 24 / scale })
      if (Math.hypot(rotAt.x - raw.x, rotAt.y - raw.y) <= grab) {
        capture(e)
        setDrag({
          kind: 'artRotate',
          id: selectedArt.id,
          grabAngle: (Math.atan2(raw.y - selectedArt.y, raw.x - selectedArt.x) * 180) / Math.PI,
          startRot: selectedArt.rotation,
        })
        return
      }
      for (const h of boxHandles(b)) {
        const at = artToPart(selectedArt, h.at)
        if (Math.hypot(at.x - raw.x, at.y - raw.y) <= grab) {
          capture(e)
          setDrag({ kind: 'artBox', id: selectedArt.id, fixedPart: artToPart(selectedArt, h.fixed), axis: h.axis })
          return
        }
      }
      if (selectedArt.kind === 'path') {
        const vi = selectedArt.nodes.findIndex((q) => {
          const at = artToPart(selectedArt, q)
          return Math.hypot(at.x - raw.x, at.y - raw.y) <= grab
        })
        if (vi >= 0) {
          if (doubleClicked(`av:${selectedArt.id}:${vi}`)) {
            putArt(selectedArt.id, (s) =>
              s.kind === 'path' && s.nodes.length > 2 ? recentreArt({ ...s, nodes: s.nodes.filter((_, j) => j !== vi) }) : s,
            )
            setSelNode(null)
            return
          }
          setSelNode(vi)
          capture(e)
          setDrag({ kind: 'artNode', id: selectedArt.id, index: vi })
          return
        }
      }
    }

    const hit = [...artShapes].reverse().find((s) => !s.hidden && !s.locked && artHit(s, raw, grab, measured(s)))
    if (hit) {
      setSelArt(hit.id)
      setSelNode(null)
      capture(e)
      setDrag({ kind: 'artMove', id: hit.id, origin: raw, start: { x: hit.x, y: hit.y } })
      return
    }
    setSelArt(null)
    setSelNode(null)
  }

  function onPointerMove(e: React.PointerEvent) {
    const raw = toLocal(e)
    setCursor(mode === 'texture' ? raw : penShape && drag.kind === 'none' ? penPoint(raw) : snap(raw))
    // A gesture that moved something is not half of a double-click: without
    // this, dragging a point and then clicking it again deletes it.
    if (drag.kind !== 'none' && drag.kind !== 'pan') lastDown.current = null

    switch (drag.kind) {
      case 'none':
        return
      case 'pan':
        setCam((c) => ({ ...c, x: c.x + e.clientX - drag.lastScreen.x, y: c.y + e.clientY - drag.lastScreen.y }))
        setDrag({ ...drag, lastScreen: { x: e.clientX, y: e.clientY } })
        return
      case 'pin': {
        const p = snapToStep(raw, 1)
        setDef((d) => ({ ...d, pins: d.pins.map((q) => (q.id === drag.id ? { ...q, x: p.x, y: p.y } : q)) }))
        return
      }
      case 'node': {
        const p = snap(raw)
        putShape(drag.shapeId, (s) => (s.kind === 'path' ? { ...s, nodes: moveNode(s.nodes, drag.index, p) } : s))
        return
      }
      case 'handle': {
        const p = snap(raw)
        const inArt = mode === 'texture'
        const apply = (s: ArtShape | OutlineShape) => {
          if (s.kind !== 'path') return s
          const local = inArt ? partToArt(s as ArtShape, p) : p
          return { ...s, nodes: setHandle(s.nodes, drag.index, drag.which, local, drag.mirror) }
        }
        if (inArt) putArt(drag.shapeId, (s) => apply(s) as ArtShape)
        else putShape(drag.shapeId, (s) => apply(s) as OutlineShape)
        return
      }
      case 'shapeMove': {
        const d = snapToStep({ x: raw.x - drag.origin.x, y: raw.y - drag.origin.y }, BODY_STEP)
        putShape(drag.shapeId, () => translateOutlineShape(drag.start, d))
        return
      }
      case 'shapeBox': {
        const p = snap(raw)
        putShape(drag.shapeId, (s) => setOutlineShapeBox(s, boxFromDrag(outlineShapeBounds(s), drag.fixed, p, drag.axis)))
        return
      }
      case 'shapeNew': {
        const p = snap(raw)
        const box = boundsFromCorners(drag.origin, p)
        putShape(drag.shapeId, (s) => setOutlineShapeBox(s, box))
        return
      }
      case 'lineNew': {
        const p = snap(raw)
        putShape(drag.shapeId, (s) => (s.kind === 'path' ? { ...s, nodes: lineNodes(drag.origin, p, DEFAULT_LINE_WIDTH) } : s))
        return
      }
      case 'artMove': {
        let dx = raw.x - drag.origin.x
        let dy = raw.y - drag.origin.y
        if (shiftRef.current) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }
        putArt(drag.id, (s) => ({ ...s, x: drag.start.x + dx, y: drag.start.y + dy }))
        return
      }
      case 'artBox': {
        putArt(drag.id, (s) => {
          const m = measured(s)
          const b = artLocalBounds(s, m)
          const box = boxFromDrag(b, partToArt(s, drag.fixedPart), partToArt(s, raw), drag.axis)
          if (shiftRef.current && drag.axis === 'both') {
            // Keep the aspect ratio: grow the shorter side to match.
            const k = Math.max((box.maxX - box.minX) / Math.max(1e-6, b.maxX - b.minX), (box.maxY - box.minY) / Math.max(1e-6, b.maxY - b.minY))
            const f = partToArt(s, drag.fixedPart)
            const sx = box.minX < f.x || box.maxX < f.x ? -1 : 1
            const sy = box.minY < f.y || box.maxY < f.y ? -1 : 1
            const w = (b.maxX - b.minX) * k * sx
            const h = (b.maxY - b.minY) * k * sy
            return setArtLocalBox(s, boundsFromCorners(f, { x: f.x + w, y: f.y + h }), m)
          }
          return setArtLocalBox(s, box, m)
        })
        return
      }
      case 'artRotate': {
        putArt(drag.id, (s) => {
          const a = (Math.atan2(raw.y - s.y, raw.x - s.x) * 180) / Math.PI
          let next = drag.startRot + (a - drag.grabAngle)
          if (shiftRef.current) next = Math.round(next / 15) * 15
          return { ...s, rotation: ((next % 360) + 360) % 360 }
        })
        return
      }
      case 'artNode': {
        putArt(drag.id, (s) => (s.kind === 'path' ? { ...s, nodes: moveNode(s.nodes, drag.index, partToArt(s, raw)) } : s))
        return
      }
      case 'artNew': {
        putArt(drag.id, (s) => {
          const box = boundsFromCorners(drag.origin, raw)
          // The box is in PART space; the shape has not been rotated yet, so
          // its local frame is a pure translation of it.
          const w = Math.max(0.02, box.maxX - box.minX)
          const h = Math.max(0.02, box.maxY - box.minY)
          const cx = (box.minX + box.maxX) / 2
          const cy = (box.minY + box.maxY) / 2
          if (s.kind === 'rect') return { ...s, x: cx, y: cy, w, h }
          if (s.kind === 'ellipse') return { ...s, x: cx, y: cy, rx: w / 2, ry: h / 2 }
          return s
        })
        return
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (drag.kind !== 'none') {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // capture may already be gone
      }
    }
    // A zero-size drag-create is a click; give it something visible instead.
    if (drag.kind === 'shapeNew') {
      const s = shapes.find((x) => x.id === drag.shapeId)
      if (s) {
        const b = outlineShapeBounds(s)
        if (b.maxX - b.minX < BODY_STEP || b.maxY - b.minY < BODY_STEP) {
          putShape(s.id, (x) => setOutlineShapeBox(x, { minX: b.minX, minY: b.minY, maxX: b.minX + 2, maxY: b.minY + 1 }))
        }
      }
      setOutlineTool('select')
    }
    if (drag.kind === 'lineNew') {
      const s = shapes.find((x) => x.id === drag.shapeId)
      if (s) {
        const b = outlineShapeBounds(s)
        if (Math.max(b.maxX - b.minX, b.maxY - b.minY) < BODY_STEP) {
          putShape(s.id, (x) =>
            x.kind === 'path' ? { ...x, nodes: lineNodes(drag.origin, { x: drag.origin.x + 2, y: drag.origin.y }, DEFAULT_LINE_WIDTH) } : x,
          )
        }
      }
      setOutlineTool('select')
      setSelShape(drag.shapeId)
    }
    if (drag.kind === 'artNew') {
      const s = artShapes.find((x) => x.id === drag.id)
      if (s) {
        const b = artLocalBounds(s, measured(s))
        if (b.maxX - b.minX < 0.06 || b.maxY - b.minY < 0.06) {
          putArt(s.id, (x) => setArtLocalBox(x, { minX: -0.75, minY: -0.375, maxX: 0.75, maxY: 0.375 }, measured(x)))
        }
      }
      setArtTool('select')
    }
    if (drag.kind === 'artNode') putArt(drag.id, (s) => recentreArt(s))
    setDrag({ kind: 'none' })
  }

  /** Where the pen would put the next point, with Shift constraining the run. */
  const penPoint = useCallback(
    (raw: Vec): Vec => {
      if (!shiftRef.current || !penShape || penShape.kind !== 'path' || penShape.nodes.length === 0) return snap(raw)
      return snap(constrain8(penShape.nodes[penShape.nodes.length - 1], raw))
    },
    [penShape, snap],
  )

  function removeNode(shapeId: string, index: number) {
    const s = shapes.find((x) => x.id === shapeId)
    if (!s || s.kind !== 'path') return
    const floor = s.closed ? 3 : 2
    if (s.nodes.length <= floor) {
      setError(s.closed ? 'A closed path needs at least three points.' : 'A line needs at least two points.')
      return
    }
    putShape(shapeId, (x) => (x.kind === 'path' ? { ...x, nodes: x.nodes.filter((_, j) => j !== index) } : x))
    setSelNode(null)
  }

  // ---- image backdrop -----------------------------------------------------
  async function onUpload(file: File) {
    try {
      setError('')
      const { bytes, mime } = await readImageFile(file)
      const { id, meta } = await putAsset(bytes, mime, file.name)
      setNewAssets((a) => ({ ...a, [id]: meta }))
      const pts = sampleOutline(def.outline)
      const b = pts.length ? boundsOf(pts) : { minX: 0, minY: 0, maxX: 4, maxY: 2 }
      setDef((d) => ({
        ...d,
        texture: {
          assetId: id,
          x: b.minX,
          y: b.minY,
          w: Math.max(1, b.maxX - b.minX),
          h: Math.max(1, b.maxY - b.minY),
          opacity: 1,
          clipToOutline: true,
        },
      }))
      setMode('texture')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  function save() {
    finishPen(true)
    finishArtPen(true)
    if (outlineIsEmpty(def.outline)) {
      setError('The body needs at least one shape.')
      return
    }
    if (def.pins.length === 0) {
      setError('Add at least one pin.')
      return
    }
    onSave(def, newAssets)
  }

  // ---- keyboard -----------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = true
      const t = e.target as HTMLElement
      if (t && /input|textarea/i.test(t.tagName)) return
      if (e.key === 'Escape') {
        if (penId) finishPen(false)
        else if (artPenId) finishArtPen(false)
        else onCancel()
      }
      if (e.key === 'Enter') {
        if (penId) finishPen(true)
        if (artPenId) finishArtPen(true)
      }
      if (e.key === '0') setCam(fitTo(artworkBounds(), size.w, size.h))
      if (mode === 'outline' && (e.key === 'v' || e.key === 'V')) setOutlineTool('select')
      if (mode === 'outline' && (e.key === 'p' || e.key === 'P')) setOutlineTool('pen')
      if (mode === 'texture' && (e.key === 'v' || e.key === 'V')) setArtTool('select')
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (mode === 'outline') {
          if (penShape && penShape.kind === 'path' && penShape.nodes.length > 0) {
            if (penShape.nodes.length === 1) dropShape(penShape.id)
            else putShape(penShape.id, (s) => (s.kind === 'path' ? { ...s, nodes: s.nodes.slice(0, -1) } : s))
          } else if (selected && selNode !== null) removeNode(selected.id, selNode)
          else if (selShape) dropShape(selShape)
        } else if (mode === 'texture') {
          if (selArt) dropArt(selArt)
        } else if (selPin) {
          setDef((d) => ({ ...d, pins: d.pins.filter((p) => p.id !== selPin) }))
          setSelPin(null)
        }
      }
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') shiftRef.current = false
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', up)
    }
  })

  // ---- derived ------------------------------------------------------------
  const assetUrls = useMemo(() => {
    if (!def.texture) return {}
    const mime = newAssets[def.texture.assetId]?.mime ?? assets?.[def.texture.assetId]?.mime ?? 'image/png'
    return { [def.texture.assetId]: assetUrl(def.texture.assetId, mime) }
  }, [def.texture, newAssets, assets])

  /** The pen's run is previewed separately, so it never renders as a stray lead. */
  const displayDef = useMemo<PartDef>(
    () => (penId ? { ...def, outline: { ...def.outline, shapes: def.outline.shapes.filter((s) => s.id !== penId) } } : def),
    [def, penId],
  )

  /** Handles for inserting a node, on every segment including the closing one. */
  const midpoints = useMemo(() => {
    if (!selected || selected.kind !== 'path' || penId === selected.id) return []
    const pts = selected.nodes
    const out: { at: Vec; index: number }[] = []
    const last = selected.closed ? pts.length : pts.length - 1
    for (let i = 0; i < last; i++) {
      const q = pts[(i + 1) % pts.length]
      out.push({ at: { x: (pts[i].x + q.x) / 2, y: (pts[i].y + q.y) / 2 }, index: i + 1 })
    }
    return out
  }, [selected, penId])

  /** Visible world rectangle, so the grid is exactly one <rect>. */
  const worldView = {
    minX: Math.floor(-cam.x / scale) - 1,
    minY: Math.floor(-cam.y / scale) - 1,
    maxX: Math.ceil((size.w - cam.x) / scale) + 1,
    maxY: Math.ceil((size.h - cam.y) / scale) + 1,
  }

  const outlinePts = sampleOutline(def.outline)
  const bounds = outlinePts.length > 1 ? boundsOf(outlinePts) : null
  const handleR = 5 / scale

  const pxPerMm = scale / MM_PER_HOLE
  /** Longest nice round length that still fits in ~110px of bar. */
  const barMm = [100, 50, 20, 10, 5, 2, 1].find((v) => v * pxPerMm <= 130) ?? 1

  const shapeItems: LayerItem[] = [...shapes].reverse().map((s) => ({
    id: s.id,
    label: outlineShapeLabel(s),
    badge: s.subtract ? 'cut' : undefined,
    hidden: s.hidden,
  }))

  const artItems: LayerItem[] = [...artShapes].reverse().map((s) => ({
    id: s.id,
    label: s.kind === 'text' ? `“${s.text}”` : s.name,
    badge: s.kind,
    hidden: s.hidden,
    locked: s.locked,
  }))

  function reorderArt(id: string, toDisplayIndex: number) {
    setArtwork((a) => {
      const from = a.shapes.findIndex((s) => s.id === id)
      if (from < 0) return a
      // The list reads top-first; paint order is bottom-first.
      const to = a.shapes.length - 1 - toDisplayIndex
      const next = [...a.shapes]
      const [moved] = next.splice(from, 1)
      next.splice(Math.max(0, Math.min(next.length, to)), 0, moved)
      return { ...a, shapes: next }
    })
  }

  const penPreviewD = (() => {
    if (!penShape || penShape.kind !== 'path') return ''
    const nodes = cursor && drag.kind === 'none' ? [...penShape.nodes, node(cursor.x, cursor.y)] : penShape.nodes
    return nodesD(nodes, false)
  })()

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <header className="modal-head">
          <strong>{initial ? 'Edit part' : 'New part'}</strong>
          <div className="group">
            {(['outline', 'pins', 'texture'] as Mode[]).map((m) => (
              <button key={m} className={`btn ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
                {m === 'outline' ? 'Shape' : m === 'pins' ? 'Pins' : 'Texture'}
              </button>
            ))}
          </div>
          <span className="spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save part
          </button>
        </header>

        <div className="modal-body">
          <div className="editor-canvas" ref={hostRef}>
            <svg
              ref={svgRef}
              width="100%"
              height="100%"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={(e) => {
                onPointerUp(e)
                setCursor(null)
              }}
              style={{
                display: 'block',
                touchAction: 'none',
                cursor:
                  drag.kind === 'pan'
                    ? 'grabbing'
                    : (mode === 'outline' && outlineTool === 'select') || (mode === 'texture' && artTool === 'select')
                      ? 'default'
                      : 'crosshair',
                background: '#fff',
              }}
            >
              <g transform={`translate(${cam.x} ${cam.y}) scale(${scale})`}>
                {/* One rect for the whole lattice: the half-hole grid and the
                    whole holes both live in a single 1x1 pattern tile. */}
                <defs>
                  {/* The tile is offset by a quarter hole so no dot sits on a
                      tile edge — a clipped dot renders as a quarter moon. */}
                  <pattern id="pe-grid" patternUnits="userSpaceOnUse" width={1} height={1} x={-0.25} y={-0.25}>
                    <circle cx={0.75} cy={0.25} r={0.035} fill="#dedede" />
                    <circle cx={0.25} cy={0.75} r={0.035} fill="#dedede" />
                    <circle cx={0.75} cy={0.75} r={0.035} fill="#dedede" />
                    <circle cx={0.25} cy={0.25} r={0.1} fill="#bfbfbf" />
                  </pattern>
                </defs>
                <rect
                  x={worldView.minX}
                  y={worldView.minY}
                  width={worldView.maxX - worldView.minX}
                  height={worldView.maxY - worldView.minY}
                  fill="url(#pe-grid)"
                  pointerEvents="none"
                />

                {/* origin */}
                <g pointerEvents="none" opacity={0.6}>
                  <line x1={-0.45} y1={0} x2={0.45} y2={0} stroke="#1E88E5" strokeWidth={1 / scale} />
                  <line x1={0} y1={-0.45} x2={0} y2={0.45} stroke="#1E88E5" strokeWidth={1 / scale} />
                </g>

                <g pointerEvents="none">
                  <PartGraphics def={displayDef} idPrefix="pe" assetUrls={assetUrls} />
                </g>

                {/* pen run in progress */}
                {penPreviewD && (
                  <path
                    d={penPreviewD}
                    fill="none"
                    stroke="#1E88E5"
                    strokeWidth={2 / scale}
                    strokeDasharray={`${6 / scale} ${4 / scale}`}
                    pointerEvents="none"
                  />
                )}

                {/* ---- outline overlays ---- */}
                {mode === 'outline' && selected && (
                  <ShapeOverlay
                    shape={selected}
                    selNode={selNode}
                    isPen={penId === selected.id}
                    midpoints={midpoints}
                    handleR={handleR}
                    scale={scale}
                  />
                )}
                {mode === 'outline' &&
                  penShape &&
                  penShape.kind === 'path' &&
                  penShape.nodes.map((p, i) => (
                    <g key={`pn${i}`} pointerEvents="none">
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={handleR}
                        fill={i === 0 ? '#1E88E5' : '#fff'}
                        stroke="#1E88E5"
                        strokeWidth={1.5 / scale}
                      />
                      {i === 0 && penShape.nodes.length >= 3 && outlineTool === 'pen' && (
                        <circle cx={p.x} cy={p.y} r={handleR * 1.9} fill="none" stroke="#1E88E5" strokeWidth={1 / scale} opacity={0.6} />
                      )}
                    </g>
                  ))}

                {/* ---- artwork overlays ---- */}
                {mode === 'texture' && selectedArt && (
                  <ArtOverlay
                    shape={selectedArt}
                    box={artLocalBounds(selectedArt, measured(selectedArt))}
                    selNode={selNode}
                    handleR={handleR}
                    scale={scale}
                  />
                )}

                {/* pins */}
                {def.pins.map((p) => (
                  <g key={p.id} pointerEvents="none">
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={0.22}
                      fill="#EDEDED"
                      stroke={selPin === p.id ? '#1E88E5' : '#555'}
                      strokeWidth={0.07}
                    />
                    <circle cx={p.x} cy={p.y} r={0.08} fill="#555" />
                  </g>
                ))}

                {cursor && mode !== 'texture' && drag.kind === 'none' && (
                  <circle cx={cursor.x} cy={cursor.y} r={handleR * 0.7} fill="#1E88E5" opacity={0.45} pointerEvents="none" />
                )}

                {/* Off-screen measuring copies of every text layer: the browser
                    is the only thing that knows how wide a string renders. */}
                <g visibility="hidden" pointerEvents="none">
                  {artShapes.map((s) =>
                    s.kind === 'text' ? (
                      <text
                        key={s.id}
                        ref={(el) => {
                          if (el) textEls.current.set(s.id, el)
                          else textEls.current.delete(s.id)
                        }}
                        textAnchor={s.align}
                        dominantBaseline="central"
                        fontSize={s.fontSize}
                        fontFamily={s.fontFamily}
                        fontWeight={s.bold ? 700 : 400}
                        fontStyle={s.italic ? 'italic' : 'normal'}
                      >
                        {s.text}
                      </text>
                    ) : null,
                  )}
                </g>
              </g>

              {/* ---- screen-space overlay: labels, dimensions, rulers ---- */}
              <g pointerEvents="none" fontFamily="ui-monospace, monospace">
                {def.pins.map((p) => {
                  const s = toScreen({ x: p.x, y: p.y })
                  return (
                    // White halo via paint-order, so a pin name stays readable
                    // on a dark body as well as on the grid.
                    <text
                      key={p.id}
                      x={s.x}
                      y={s.y - Math.max(9, 0.3 * scale)}
                      textAnchor="middle"
                      fontSize={11}
                      fill="#222"
                      stroke="#fff"
                      strokeWidth={3}
                      strokeLinejoin="round"
                      paintOrder="stroke"
                    >
                      {p.name}
                    </text>
                  )
                })}

                {bounds && <DimensionBox bounds={bounds} toScreen={toScreen} />}
              </g>

              <Ruler
                size={size}
                thickness={RULER}
                pxPerMm={pxPerMm}
                originX={cam.x}
                originY={cam.y}
                cursorScreen={cursor ? toScreen(cursor) : null}
              />
            </svg>

            <div className="canvas-tools">
              <button className="btn small" onClick={() => setCam((c) => zoomAt(c, { x: size.w / 2, y: size.h / 2 }, 1 / 1.25))}>
                −
              </button>
              <span className="zoom-label">{Math.round(cam.zoom * 100)}%</span>
              <button className="btn small" onClick={() => setCam((c) => zoomAt(c, { x: size.w / 2, y: size.h / 2 }, 1.25))}>
                +
              </button>
              <button className="btn small" title="Fit the artwork (0)" onClick={() => setCam(fitTo(artworkBounds(), size.w, size.h))}>
                Fit
              </button>
              <span className="scale-bar-wrap">
                <span className="scale-bar" style={{ width: Math.max(14, barMm * pxPerMm) }} />
                {barMm} mm
              </span>
              {cursor && (
                <span className="coord-readout">
                  {fmtMm(cursor.x)}, {fmtMm(cursor.y)}
                </span>
              )}
            </div>
          </div>

          <aside className="editor-side">
            <label className="field">
              <span>Name</span>
              <input value={def.name} onChange={(e) => setDef({ ...def, name: e.target.value })} />
            </label>
            <label className="field">
              <span>Designator prefix</span>
              <input
                value={def.prefix}
                onChange={(e) => setDef({ ...def, prefix: e.target.value.toUpperCase().slice(0, 4) })}
              />
            </label>
            <div className="field row">
              <label>
                <span>Body</span>
                <input type="color" value={def.fill} onChange={(e) => setDef({ ...def, fill: e.target.value })} />
              </label>
              <label>
                <span>Edge</span>
                <input type="color" value={def.stroke} onChange={(e) => setDef({ ...def, stroke: e.target.value })} />
              </label>
            </div>

            {mode === 'outline' && (
              <>
                <div className="tool-row">
                  {(
                    [
                      ['select', 'Select', 'V', SelectIcon],
                      ['pen', 'Pen', 'P', PenIcon],
                      ['line', 'Line', '', LineIcon],
                      ['rect', 'Rect', '', RectIcon],
                      ['ellipse', 'Circle', '', EllipseIcon],
                    ] as [OutlineTool, string, string, typeof SelectIcon][]
                  ).map(([t, label, key, Icon]) => (
                    <button
                      key={t}
                      className={`btn icon ${outlineTool === t ? 'active' : ''}`}
                      title={key ? `${label} (${key})` : label}
                      aria-label={label}
                      onClick={() => setOutlineTool(t)}
                    >
                      <Icon />
                    </button>
                  ))}
                  <InfoTip>
                    Everything here snaps to half holes. Shapes ADD to the body by default — draw an overlapping
                    circle and a rect and they read as one piece, no seam. Check "cut this shape out of the body"
                    to subtract one instead. <b>Pen</b>: click to place points, <b>drag</b> as you place one to pull
                    a curve out of it; click the first point or press Enter to close. <b>Line</b> drags out a thin
                    rectangle — a lead is just a shape like any other. <b>Rect</b>/<b>Circle</b>: drag a box. With{' '}
                    <b>Select</b>, drag a shape to move it, its box handles to resize, a point to reshape, and
                    double-click a point to remove it.
                  </InfoTip>
                </div>

                <label className="field">
                  <span>Corner radius — {fmtMm(def.outline.cornerRadius ?? 0)}</span>
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.01}
                    value={def.outline.cornerRadius ?? 0}
                    onChange={(e) => setOutline((o) => ({ ...o, cornerRadius: Number(e.target.value) }))}
                  />
                </label>
                <div className="hint">
                  Rounds the corners of the finished silhouette — the whole body, not one shape. Each corner is
                  clamped to half its shortest edge, so a curve stays a curve.
                </div>

                <div className="side-title">Body shapes</div>
                <LayersPanel
                  items={shapeItems}
                  selectedId={selShape}
                  onSelect={(id) => {
                    setSelShape(id)
                    setSelNode(null)
                    setOutlineTool('select')
                  }}
                  onDelete={dropShape}
                  onRename={(id, name) => putShape(id, (s) => ({ ...s, name }))}
                  onToggleHidden={(id) => putShape(id, (s) => ({ ...s, hidden: !s.hidden }))}
                  empty="No shapes yet — draw one."
                />

                {selected && (
                  <div className="shape-props">
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={!!selected.subtract}
                        onChange={(e) => putShape(selected.id, (s) => ({ ...s, subtract: e.target.checked }))}
                      />
                      cut this shape out of the body
                    </label>
                    {selected.kind === 'path' && selNode !== null && selNode < selected.nodes.length && (
                      <div className="group">
                        <button
                          className="btn small"
                          onClick={() => putShape(selected.id, (s) => (s.kind === 'path' ? { ...s, nodes: smoothNode(s.nodes, selNode, s.closed) } : s))}
                        >
                          Curve point
                        </button>
                        <button
                          className="btn small"
                          onClick={() =>
                            putShape(selected.id, (s) =>
                              s.kind === 'path'
                                ? { ...s, nodes: s.nodes.map((n, j) => (j === selNode ? { x: n.x, y: n.y } : n)) }
                                : s,
                            )
                          }
                        >
                          Corner
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

            {mode === 'pins' && (
              <>
                <div className="hint">
                  Click a whole hole to add a pin. Drag a pin to move it, double-click it to delete it.
                </div>
                <div className="pin-list">
                  {def.pins.map((p) => (
                    <div key={p.id} className={`pin-row ${selPin === p.id ? 'sel' : ''}`}>
                      <input
                        value={p.name}
                        onChange={(e) =>
                          setDef({
                            ...def,
                            pins: def.pins.map((q) => (q.id === p.id ? { ...q, name: e.target.value } : q)),
                          })
                        }
                        onFocus={() => setSelPin(p.id)}
                      />
                      <span className="coord">
                        {p.x},{p.y}
                      </span>
                      <button className="btn small" onClick={() => setDef({ ...def, pins: def.pins.filter((q) => q.id !== p.id) })}>
                        ×
                      </button>
                    </div>
                  ))}
                  {def.pins.length === 0 && <div className="empty">No pins yet.</div>}
                </div>
              </>
            )}

            {mode === 'texture' && (
              <>
                <div className="tool-row">
                  {(
                    [
                      ['select', 'Select', SelectIcon],
                      ['rect', 'Rect', RectIcon],
                      ['ellipse', 'Circle', EllipseIcon],
                      ['pen', 'Pen', PenIcon],
                      ['line', 'Line', LineIcon],
                      ['text', 'Text', TextIcon],
                    ] as [ArtTool, string, typeof SelectIcon][]
                  ).map(([t, label, Icon]) => (
                    <button
                      key={t}
                      className={`btn icon ${artTool === t ? 'active' : ''}`}
                      title={label}
                      aria-label={label}
                      onClick={() => setArtTool(t)}
                    >
                      <Icon />
                    </button>
                  ))}
                  <InfoTip>
                    Artwork is free of the grid: move, rotate and resize it anywhere. Select a layer to see its box
                    — corner handles resize (Shift keeps the ratio), the stalk above it rotates (Shift snaps to
                    15°). <b>Line</b> here stays an open stroke — this is decoration, not the body.
                  </InfoTip>
                </div>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={artwork.clipToOutline}
                    onChange={(e) => setArtwork((a) => ({ ...a, clipToOutline: e.target.checked }))}
                  />
                  mask artwork to the part shape
                </label>

                <div className="side-title">Layers</div>
                <LayersPanel
                  items={artItems}
                  selectedId={selArt}
                  onSelect={(id) => {
                    setSelArt(id)
                    setSelNode(null)
                    setArtTool('select')
                  }}
                  onDelete={dropArt}
                  onRename={(id, name) => putArt(id, (s) => ({ ...s, name }))}
                  onToggleHidden={(id) => putArt(id, (s) => ({ ...s, hidden: !s.hidden }))}
                  onToggleLocked={(id) => putArt(id, (s) => ({ ...s, locked: !s.locked }))}
                  onReorder={reorderArt}
                  empty="No artwork yet — pick a tool and draw."
                />

                {selectedArt && <ArtProps shape={selectedArt} onChange={(f) => putArt(selectedArt.id, f)} />}

                <details className="backdrop">
                  <summary>Image backdrop</summary>
                  <div className="hint">PNG, JPEG or SVG, painted under the vector layers. SVG uploads are sanitised.</div>
                  <input
                    type="file"
                    accept={ACCEPTED_IMAGE_TYPES}
                    onChange={(e) => {
                      const f = e.target.files?.[0]
                      if (f) void onUpload(f)
                    }}
                  />
                  {def.texture && (
                    <>
                      {(['x', 'y', 'w', 'h'] as const).map((k) => (
                        <label className="field" key={k}>
                          <span>
                            {k.toUpperCase()} — {fmtMm(def.texture![k])}
                          </span>
                          <input
                            type="number"
                            step={0.5}
                            value={def.texture![k]}
                            onChange={(e) => setDef({ ...def, texture: { ...def.texture!, [k]: Number(e.target.value) } })}
                          />
                        </label>
                      ))}
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={def.texture.clipToOutline}
                          onChange={(e) => setDef({ ...def, texture: { ...def.texture!, clipToOutline: e.target.checked } })}
                        />
                        clip the image to the part shape
                      </label>
                      <button className="btn small" onClick={() => setDef({ ...def, texture: undefined })}>
                        Remove image
                      </button>
                    </>
                  )}
                </details>
              </>
            )}

            <div className="dims">
              {bounds && (
                <>
                  <div>
                    <b>
                      {fmtMm(bounds.maxX - bounds.minX)} × {fmtMm(bounds.maxY - bounds.minY)}
                    </b>
                  </div>
                  <div>
                    {(bounds.maxX - bounds.minX).toFixed(1)} × {(bounds.maxY - bounds.minY).toFixed(1)} holes ·{' '}
                    {def.pins.length} pins
                  </div>
                </>
              )}
            </div>
            {error && <div className="err-msg">{error}</div>}
          </aside>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- node maths

/** Move a node, carrying its handles with it so the curve keeps its shape. */
function moveNode(nodes: PathNode[], index: number, to: Vec): PathNode[] {
  return nodes.map((n, j) => {
    if (j !== index) return n
    const dx = to.x - n.x
    const dy = to.y - n.y
    return {
      x: to.x,
      y: to.y,
      hIn: n.hIn ? { x: n.hIn.x + dx, y: n.hIn.y + dy } : undefined,
      hOut: n.hOut ? { x: n.hOut.x + dx, y: n.hOut.y + dy } : undefined,
    }
  })
}

/**
 * Set one control handle. `mirror` is the pen's live drag: the opposite handle
 * follows in reflection, which is what makes a dragged point smooth. Pulling
 * less than a hair leaves the point a corner, so a plain click is still a click.
 */
function setHandle(nodes: PathNode[], index: number, which: 'hIn' | 'hOut', to: Vec, mirror: boolean): PathNode[] {
  return nodes.map((n, j) => {
    if (j !== index) return n
    if (mirror && Math.hypot(to.x - n.x, to.y - n.y) < HANDLE_DEADZONE) {
      return { x: n.x, y: n.y }
    }
    const other = { x: 2 * n.x - to.x, y: 2 * n.y - to.y }
    if (!mirror) return { ...n, [which]: to }
    return { x: n.x, y: n.y, hOut: to, hIn: other }
  })
}

/** Give a corner point handles along the line through its neighbours. */
function smoothNode(nodes: PathNode[], index: number, closed: boolean): PathNode[] {
  const n = nodes[index]
  const prev = nodes[(index - 1 + nodes.length) % nodes.length]
  const next = nodes[(index + 1) % nodes.length]
  if (!prev || !next || (!closed && (index === 0 || index === nodes.length - 1))) {
    const ref = next ?? prev
    if (!ref) return nodes
    const d = { x: (ref.x - n.x) / 3, y: (ref.y - n.y) / 3 }
    return nodes.map((q, j) => (j === index ? { ...q, hOut: { x: n.x + d.x, y: n.y + d.y }, hIn: { x: n.x - d.x, y: n.y - d.y } } : q))
  }
  const d = { x: (next.x - prev.x) / 6, y: (next.y - prev.y) / 6 }
  return nodes.map((q, j) =>
    j === index ? { ...q, hOut: { x: n.x + d.x, y: n.y + d.y }, hIn: { x: n.x - d.x, y: n.y - d.y } } : q,
  )
}

// ------------------------------------------------------------------ overlays

function ShapeOverlay({
  shape,
  selNode,
  isPen,
  midpoints,
  handleR,
  scale,
}: {
  shape: OutlineShape
  selNode: number | null
  isPen: boolean
  midpoints: { at: Vec; index: number }[]
  handleR: number
  scale: number
}) {
  const b = outlineShapeBounds(shape)
  return (
    <g pointerEvents="none">
      {!isPen && (
        <>
          <rect
            x={b.minX}
            y={b.minY}
            width={b.maxX - b.minX}
            height={b.maxY - b.minY}
            fill="none"
            stroke="#1E88E5"
            strokeOpacity={0.5}
            strokeWidth={1 / scale}
            strokeDasharray={`${4 / scale} ${3 / scale}`}
          />
          {boxHandles(b).map((h, i) => (
            <rect
              key={i}
              x={h.at.x - handleR * 0.8}
              y={h.at.y - handleR * 0.8}
              width={handleR * 1.6}
              height={handleR * 1.6}
              fill="#fff"
              stroke="#1E88E5"
              strokeWidth={1.2 / scale}
            />
          ))}
        </>
      )}

      {midpoints.map((m) => (
        <circle
          key={`mid${m.index}`}
          cx={m.at.x}
          cy={m.at.y}
          r={handleR * 0.8}
          fill="#fff"
          stroke="#9bc4e8"
          strokeWidth={1 / scale}
        />
      ))}

      {shape.kind === 'path' &&
        !isPen &&
        shape.nodes.map((p, i) => (
          <g key={i}>
            {i === selNode &&
              (['hIn', 'hOut'] as const).map((which) => {
                const h = p[which]
                if (!h) return null
                return (
                  <g key={which}>
                    <line x1={p.x} y1={p.y} x2={h.x} y2={h.y} stroke="#7AA7D6" strokeWidth={1 / scale} />
                    <circle cx={h.x} cy={h.y} r={handleR * 0.8} fill="#7AA7D6" stroke="#fff" strokeWidth={1 / scale} />
                  </g>
                )
              })}
            <circle
              cx={p.x}
              cy={p.y}
              r={handleR}
              fill={selNode === i ? '#1E88E5' : '#fff'}
              stroke="#1E88E5"
              strokeWidth={1.5 / scale}
            />
          </g>
        ))}
    </g>
  )
}

function ArtOverlay({
  shape,
  box,
  selNode,
  handleR,
  scale,
}: {
  shape: ArtShape
  box: Bounds
  selNode: number | null
  handleR: number
  scale: number
}) {
  const corners = [
    { x: box.minX, y: box.minY },
    { x: box.maxX, y: box.minY },
    { x: box.maxX, y: box.maxY },
    { x: box.minX, y: box.maxY },
  ].map((p) => artToPart(shape, p))
  const rotAt = artToPart(shape, { x: (box.minX + box.maxX) / 2, y: box.minY - 24 / scale })
  const topMid = artToPart(shape, { x: (box.minX + box.maxX) / 2, y: box.minY })
  return (
    <g pointerEvents="none">
      <polygon
        points={corners.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke="#1E88E5"
        strokeWidth={1.2 / scale}
        strokeDasharray={`${4 / scale} ${3 / scale}`}
      />
      <line x1={topMid.x} y1={topMid.y} x2={rotAt.x} y2={rotAt.y} stroke="#1E88E5" strokeWidth={1 / scale} />
      <circle cx={rotAt.x} cy={rotAt.y} r={handleR} fill="#fff" stroke="#1E88E5" strokeWidth={1.4 / scale} />
      {boxHandles(box).map((h, i) => {
        const at = artToPart(shape, h.at)
        return (
          <rect
            key={i}
            x={at.x - handleR * 0.8}
            y={at.y - handleR * 0.8}
            width={handleR * 1.6}
            height={handleR * 1.6}
            fill="#fff"
            stroke="#1E88E5"
            strokeWidth={1.2 / scale}
          />
        )
      })}
      {shape.kind === 'path' &&
        shape.nodes.map((p, i) => {
          const at = artToPart(shape, p)
          return (
            <circle
              key={i}
              cx={at.x}
              cy={at.y}
              r={handleR * 0.85}
              fill={selNode === i ? '#1E88E5' : '#fff'}
              stroke="#1E88E5"
              strokeWidth={1.3 / scale}
            />
          )
        })}
    </g>
  )
}

// -------------------------------------------------------------- art property panel

function ArtProps({ shape, onChange }: { shape: ArtShape; onChange: (f: (s: ArtShape) => ArtShape) => void }) {
  const set = <K extends keyof ArtShape>(key: K, value: ArtShape[K]) => onChange((s) => ({ ...s, [key]: value }))
  const noFill = shape.fill === 'none'
  const noStroke = shape.stroke === 'none'
  return (
    <div className="shape-props">
      <div className="field row">
        <label>
          <span>Fill</span>
          <input
            type="color"
            value={noFill ? '#ffffff' : shape.fill}
            onChange={(e) => set('fill', e.target.value)}
          />
        </label>
        <label className="check tight">
          <input type="checkbox" checked={!noFill} onChange={(e) => set('fill', e.target.checked ? '#FFFFFF' : 'none')} />
          on
        </label>
        <label>
          <span>Stroke</span>
          <input
            type="color"
            value={noStroke ? '#000000' : shape.stroke}
            onChange={(e) => set('stroke', e.target.value)}
          />
        </label>
        <label className="check tight">
          <input type="checkbox" checked={!noStroke} onChange={(e) => set('stroke', e.target.checked ? '#000000' : 'none')} />
          on
        </label>
      </div>

      {!noStroke && (
        <label className="field">
          <span>Stroke width — {fmtMm(shape.strokeWidth)}</span>
          <input
            type="range"
            min={0.01}
            max={0.5}
            step={0.01}
            value={shape.strokeWidth}
            onChange={(e) => set('strokeWidth', Number(e.target.value))}
          />
        </label>
      )}

      <label className="field">
        <span>Opacity — {Math.round(shape.opacity * 100)}%</span>
        <input type="range" min={0} max={1} step={0.01} value={shape.opacity} onChange={(e) => set('opacity', Number(e.target.value))} />
      </label>

      <label className="field">
        <span>Rotation — {Math.round(shape.rotation)}°</span>
        <input type="range" min={0} max={360} step={1} value={shape.rotation} onChange={(e) => set('rotation', Number(e.target.value))} />
      </label>

      {shape.kind === 'rect' && (
        <label className="field">
          <span>Corner radius — {fmtMm(shape.radius)}</span>
          <input
            type="range"
            min={0}
            max={Math.min(shape.w, shape.h) / 2}
            step={0.01}
            value={shape.radius}
            onChange={(e) => onChange((s) => (s.kind === 'rect' ? { ...s, radius: Number(e.target.value) } : s))}
          />
        </label>
      )}

      {shape.kind === 'text' && (
        <>
          <label className="field">
            <span>Text</span>
            <input value={shape.text} onChange={(e) => onChange((s) => (s.kind === 'text' ? { ...s, text: e.target.value } : s))} />
          </label>
          <label className="field">
            <span>Size — {fmtMm(shape.fontSize)}</span>
            <input
              type="range"
              min={0.1}
              max={4}
              step={0.01}
              value={shape.fontSize}
              onChange={(e) => onChange((s) => (s.kind === 'text' ? { ...s, fontSize: Number(e.target.value) } : s))}
            />
          </label>
          <div className="field row">
            <label>
              <span>Font</span>
              <select
                value={shape.fontFamily}
                onChange={(e) => onChange((s) => (s.kind === 'text' ? { ...s, fontFamily: e.target.value } : s))}
              >
                {FONTS.map(([label, family]) => (
                  <option key={family} value={family}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Align</span>
              <select
                value={shape.align}
                onChange={(e) => onChange((s) => (s.kind === 'text' ? { ...s, align: e.target.value as ArtAlign } : s))}
              >
                <option value="start">Left</option>
                <option value="middle">Centre</option>
                <option value="end">Right</option>
              </select>
            </label>
          </div>
          <div className="group">
            <button
              className={`btn small ${shape.bold ? 'active' : ''}`}
              onClick={() => onChange((s) => (s.kind === 'text' ? { ...s, bold: !s.bold } : s))}
            >
              <b>B</b>
            </button>
            <button
              className={`btn small ${shape.italic ? 'active' : ''}`}
              onClick={() => onChange((s) => (s.kind === 'text' ? { ...s, italic: !s.italic } : s))}
            >
              <i>I</i>
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** Bounding box of the body, annotated in millimetres, drawn in screen space
 *  so the labels stay legible at any zoom. */
function DimensionBox({ bounds, toScreen }: { bounds: Bounds; toScreen: (p: Vec) => Vec }) {
  const a = toScreen({ x: bounds.minX, y: bounds.minY })
  const b = toScreen({ x: bounds.maxX, y: bounds.maxY })
  const w = bounds.maxX - bounds.minX
  const h = bounds.maxY - bounds.minY
  if (w <= 0 && h <= 0) return null
  return (
    <g>
      <rect x={a.x} y={a.y} width={b.x - a.x} height={b.y - a.y} fill="none" stroke="#1E88E5" strokeOpacity={0.35} strokeDasharray="3 3" />
      <text x={(a.x + b.x) / 2} y={a.y - 8} textAnchor="middle" fontSize={11} fill="#1E88E5">
        {fmtMm(w)}
      </text>
      <text x={a.x - 8} y={(a.y + b.y) / 2} textAnchor="end" dominantBaseline="middle" fontSize={11} fill="#1E88E5">
        {fmtMm(h)}
      </text>
    </g>
  )
}
