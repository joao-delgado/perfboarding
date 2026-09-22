import { useMemo } from 'react'
import { updatePart } from '../model/project'
import { commit, getState, selectOne, set, useEditor } from '../model/store'
import { hiddenIds, pruneSelection } from '../model/visibility'
import { PartThumb } from './PartThumb'
import { EyeIcon, EyeOffIcon } from './ToolIcons'
import { Section } from './Section'

/**
 * Every component actually placed on the canvas, with an eye toggle per row.
 *
 * This is the placement list — the Library section below it is the catalogue of
 * definitions you can drag from. Hiding a row hides the part AND the wiring
 * attached to it (`model/visibility.ts`); it is a view state only, so nets,
 * hole occupancy and the rest of the document are untouched.
 */
export function ComponentsPanel({ assetUrls }: { assetUrls: Record<string, string> }) {
  const s = useEditor()
  const { parts, defs } = s.project
  const hidden = useMemo(() => hiddenIds(s.project), [s.project])
  const anyHidden = hidden.parts.size > 0

  function setHidden(ids: string[], hide: boolean) {
    commit((p) => ids.reduce((acc, id) => updatePart(acc, id, { hidden: hide || undefined }), p))
    // A hidden part must not stay selected: it could otherwise be nudged or
    // deleted from the keyboard with nothing on screen to show for it.
    if (hide) {
      const st = getState()
      set({ selection: pruneSelection(st.selection, hiddenIds(st.project)) })
    }
  }

  return (
    <Section
      id="components"
      title="Components"
      defaultHeight={200}
      headerExtra={
        anyHidden ? (
          <button
            className="btn small"
            title="Show every hidden component"
            onClick={() => setHidden([...hidden.parts], false)}
          >
            Show all
          </button>
        ) : (
          <span className="head-count">{parts.length}</span>
        )
      }
    >
      <div className="comp-list">
        {parts.map((inst) => {
          const def = defs[inst.defId]
          const off = !!inst.hidden
          return (
            <div
              key={inst.id}
              className={`comp-row${s.selection.parts.includes(inst.id) ? ' sel' : ''}${off ? ' off' : ''}`}
              title={`${inst.ref} — ${def?.name ?? 'missing part'} · ${inst.side}`}
              onClick={(e) => {
                if (off) return
                selectOne('parts', inst.id, e.shiftKey)
              }}
            >
              <button
                className="comp-eye"
                title={off ? 'Show this component and its wiring' : 'Hide this component and its wiring'}
                onClick={(e) => {
                  e.stopPropagation()
                  setHidden([inst.id], !off)
                }}
              >
                {off ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
              </button>
              <span className="comp-thumb">
                {def && <PartThumb def={def} assetUrls={assetUrls} width={34} height={24} idPrefix="comp" />}
              </span>
              <span className="comp-name">{def?.name ?? 'missing part'}</span>
              <span className="comp-side">{inst.side === 'top' ? 'T' : 'B'}</span>
            </div>
          )
        })}
        {parts.length === 0 && <div className="empty">Nothing placed yet.</div>}
      </div>
    </Section>
  )
}
