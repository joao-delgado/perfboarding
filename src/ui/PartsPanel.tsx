import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { boundsOf } from '../model/geometry'
import { sampleOutline } from '../model/shapes'
import { set } from '../model/store'
import type { PartDef } from '../model/types'
import { PartGraphics } from './PartGraphics'
import { Section } from './Section'

function Thumb({ def, assetUrls }: { def: PartDef; assetUrls: Record<string, string> }) {
  const b = boundsOf([...sampleOutline(def.outline), ...def.pins])
  const pad = 0.6
  const w = Math.max(0.5, b.maxX - b.minX) + pad * 2
  const h = Math.max(0.5, b.maxY - b.minY) + pad * 2
  return (
    <svg
      viewBox={`${b.minX - pad} ${b.minY - pad} ${w} ${h}`}
      width={52}
      height={40}
      style={{ display: 'block' }}
    >
      <PartGraphics def={def} idPrefix={`thumb-${def.id}`} assetUrls={assetUrls} />
      {def.pins.map((p) => (
        <circle key={p.id} cx={p.x} cy={p.y} r={0.18} fill="#ddd" stroke="#666" strokeWidth={0.08} />
      ))}
    </svg>
  )
}

/** Rough dropdown height, for deciding whether it needs to open upward. */
const MENU_HEIGHT = 80

/**
 * The ⋮ button and its Edit/Delete dropdown.
 *
 * The dropdown is portaled to `document.body` and positioned `fixed` from the
 * button's own `getBoundingClientRect()` — it must NOT be a normal descendant
 * of `.part-card`, because that sits inside `.section-body`'s `overflow: auto`
 * sidebar sections and would otherwise be clipped by that scroll box the
 * moment the card is anywhere near the bottom of the list.
 */
function PartMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const open = pos !== null

  useEffect(() => {
    if (!open) return
    const close = () => setPos(null)
    const onDocDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (btnRef.current?.contains(target) || menuRef.current?.contains(target)) return
      close()
    }
    // A scroll anywhere (the sidebar section, the window) invalidates the
    // fixed position we computed at open time, so just close instead of
    // tracking it live.
    document.addEventListener('pointerdown', onDocDown)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onDocDown)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [open])

  function toggle() {
    if (open) {
      setPos(null)
      return
    }
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const right = window.innerWidth - rect.right
    if (rect.bottom + MENU_HEIGHT > window.innerHeight) {
      setPos({ bottom: window.innerHeight - rect.top + 2, right })
    } else {
      setPos({ top: rect.bottom + 2, right })
    }
  }

  return (
    <div className="part-menu">
      <button
        ref={btnRef}
        className="btn small part-menu-btn"
        draggable={false}
        title="Part actions"
        onClick={(e) => {
          e.stopPropagation()
          toggle()
        }}
      >
        ⋮
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className="part-menu-dropdown"
            draggable={false}
            style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right }}
          >
            <button
              draggable={false}
              onClick={(e) => {
                e.stopPropagation()
                setPos(null)
                onEdit()
              }}
            >
              Edit
            </button>
            <button
              draggable={false}
              className="danger"
              onClick={(e) => {
                e.stopPropagation()
                setPos(null)
                onDelete()
              }}
            >
              Delete
            </button>
          </div>,
          document.body,
        )}
    </div>
  )
}

interface Props {
  defs: PartDef[]
  assetUrls: Record<string, string>
  onNewPart: () => void
  onEditPart: (id: string) => void
  onDeletePart: (id: string) => void
}

export function PartsPanel({ defs, assetUrls, onNewPart, onEditPart, onDeletePart }: Props) {
  return (
    <Section
      id="parts"
      title="Parts"
      grow
      headerExtra={
        <button className="btn small" onClick={onNewPart}>
          + New
        </button>
      }
    >
      <div className="parts-list">
        {defs.map((def) => (
          <div
            key={def.id}
            className="part-card"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-perf-part', def.id)
              e.dataTransfer.effectAllowed = 'copy'
              // dataTransfer will not give up its payload during dragover, so
              // the canvas reads the id from the store to draw the preview.
              set({ dragDefId: def.id })
            }}
            onDragEnd={() => set({ dragDefId: null })}
            onDoubleClick={() => onEditPart(def.id)}
            title={`${def.name} — drag onto the board, double-click to edit`}
          >
            <Thumb def={def} assetUrls={assetUrls} />
            <div className="part-meta">
              <div className="part-name">{def.name}</div>
              <div className="part-sub">
                {def.pins.length} pin{def.pins.length === 1 ? '' : 's'}
                {def.builtin ? '' : ' · custom'}
              </div>
            </div>
            <PartMenu onEdit={() => onEditPart(def.id)} onDelete={() => onDeletePart(def.id)} />
          </div>
        ))}
        {defs.length === 0 && <div className="empty">No parts yet.</div>}
      </div>
    </Section>
  )
}
