import { useState } from 'react'

/**
 * A reorderable stack list, used for a part's artwork layers and for the
 * sub-shapes of its body.
 *
 * Items arrive TOP-FIRST, the way a layers list reads — the caller is
 * responsible for reversing its paint order, because only the caller knows
 * whether order means anything (artwork: yes; body shapes: no).
 */
export interface LayerItem {
  id: string
  label: string
  /** Small right-aligned tag: the shape kind, "cut", and so on. */
  badge?: string
  hidden?: boolean
  locked?: boolean
}

interface Props {
  items: LayerItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
  onRename?: (id: string, name: string) => void
  onToggleHidden?: (id: string) => void
  onToggleLocked?: (id: string) => void
  /** Move `id` to `toIndex` in the displayed (top-first) order. */
  onReorder?: (id: string, toIndex: number) => void
  empty?: string
}

export function LayersPanel({
  items,
  selectedId,
  onSelect,
  onDelete,
  onRename,
  onToggleHidden,
  onToggleLocked,
  onReorder,
  empty = 'Nothing here yet.',
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overIndex, setOverIndex] = useState<number | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  if (items.length === 0) return <div className="empty">{empty}</div>

  return (
    <div className="layer-list">
      {items.map((item, i) => (
        <div
          key={item.id}
          className={`layer-row${item.id === selectedId ? ' sel' : ''}${overIndex === i ? ' drop' : ''}`}
          draggable={!!onReorder && editing !== item.id}
          onDragStart={() => setDragId(item.id)}
          onDragOver={(e) => {
            if (!onReorder || !dragId) return
            e.preventDefault()
            setOverIndex(i)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (onReorder && dragId) onReorder(dragId, i)
            setDragId(null)
            setOverIndex(null)
          }}
          onDragEnd={() => {
            setDragId(null)
            setOverIndex(null)
          }}
          onPointerDown={() => onSelect(item.id)}
        >
          {onToggleHidden && (
            <button
              className="layer-icon"
              title={item.hidden ? 'Show' : 'Hide'}
              onClick={(e) => {
                e.stopPropagation()
                onToggleHidden(item.id)
              }}
            >
              {item.hidden ? '○' : '●'}
            </button>
          )}
          {editing === item.id && onRename ? (
            <input
              autoFocus
              defaultValue={item.label}
              onBlur={(e) => {
                onRename(item.id, e.target.value)
                setEditing(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                if (e.key === 'Escape') setEditing(null)
              }}
            />
          ) : (
            <span
              className={`layer-name${item.hidden ? ' off' : ''}`}
              onDoubleClick={() => onRename && setEditing(item.id)}
              title={onRename ? 'Double-click to rename' : item.label}
            >
              {item.label}
            </span>
          )}
          {item.badge && <span className="layer-badge">{item.badge}</span>}
          {onToggleLocked && (
            <button
              className="layer-icon"
              title={item.locked ? 'Unlock' : 'Lock'}
              onClick={(e) => {
                e.stopPropagation()
                onToggleLocked(item.id)
              }}
            >
              {item.locked ? '🔒' : '🔓'}
            </button>
          )}
          <button
            className="layer-icon danger"
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              onDelete(item.id)
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}
