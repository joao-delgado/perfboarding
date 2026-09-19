import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Collapsible, resizable sidebar section. Layout (collapsed + height) is
 * remembered per section id in localStorage so it survives a reload.
 */

const STORAGE_KEY = 'perf-wiring:panel-layout'

interface Layout {
  collapsed?: boolean
  height?: number
}

type LayoutMap = Record<string, Layout>

function loadLayout(): LayoutMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as LayoutMap) : {}
  } catch {
    return {}
  }
}

function saveLayout(map: LayoutMap) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Private-mode/blocked storage: layout just won't be remembered.
  }
}

const MIN_HEIGHT = 90

interface SectionProps {
  /** Stable key this section's layout is stored under. */
  id: string
  title: string
  /** Buttons/counters shown at the right of the header, outside the collapse toggle. */
  headerExtra?: React.ReactNode
  children: React.ReactNode
  defaultHeight?: number
  /** The one section that fills remaining space instead of taking a fixed height. */
  grow?: boolean
}

export function Section({ id, title, headerExtra, children, defaultHeight = 220, grow }: SectionProps) {
  const [layout, setLayout] = useState<Layout>(() => loadLayout()[id] ?? {})
  const resizing = useRef<{ startY: number; startHeight: number } | null>(null)
  const collapsed = !!layout.collapsed
  const height = layout.height ?? defaultHeight

  const patch = useCallback(
    (next: Partial<Layout>) => {
      setLayout((prev) => {
        const merged = { ...prev, ...next }
        const all = loadLayout()
        all[id] = merged
        saveLayout(all)
        return merged
      })
    },
    [id],
  )

  useEffect(() => {
    if (grow) return
    function onMove(e: PointerEvent) {
      if (!resizing.current) return
      const next = Math.max(MIN_HEIGHT, resizing.current.startHeight + (e.clientY - resizing.current.startY))
      patch({ height: next })
    }
    function onUp() {
      resizing.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [grow, patch])

  return (
    <div
      className={`panel section ${grow && !collapsed ? 'grow' : ''}`}
      style={!collapsed && !grow ? { height, flex: 'none' } : undefined}
    >
      <div className="panel-head">
        <span className="section-title" onClick={() => patch({ collapsed: !collapsed })}>
          <span className={`chevron ${collapsed ? 'collapsed' : ''}`}>▾</span>
          {title}
        </span>
        {headerExtra}
      </div>
      {!collapsed && <div className="section-body">{children}</div>}
      {!collapsed && !grow && (
        <div
          className="section-resize"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            resizing.current = { startY: e.clientY, startHeight: height }
          }}
        />
      )}
    </div>
  )
}
