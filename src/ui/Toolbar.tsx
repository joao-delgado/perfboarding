import { updateWire } from '../model/project'
import { commit, getState, redo, set, undo, useEditor, WIRE_COLORS } from '../model/store'

interface Props {
  onSave: () => void
  onSaveAs: () => void
  onOpen: () => void
  onNew: () => void
}

export function Toolbar({ onSave, onSaveAs, onOpen, onNew }: Props) {
  const s = useEditor()

  return (
    <div className="toolbar">
      <div className="group">
        <button className="btn" onClick={onNew}>
          New
        </button>
        <button className="btn" onClick={onOpen}>
          Open
        </button>
        <button className="btn primary" onClick={onSave} title="Save (Cmd/Ctrl+S)">
          Save{s.dirty ? ' •' : ''}
        </button>
        <button className="btn" onClick={onSaveAs} title="Save to a new file (Cmd/Ctrl+Shift+S)">
          Save as…
        </button>
      </div>

      <div className="sep" />

      <div className="group">
        <div className="switch">
          <button
            className={`switch-btn select ${s.tool === 'select' ? 'active' : ''}`}
            onClick={() => set({ tool: 'select' })}
            title="Select and move (V)"
          >
            Select
          </button>
          <button
            className={`switch-btn wire ${s.tool === 'wire' ? 'active' : ''}`}
            onClick={() => set({ tool: 'wire' })}
            title="Draw wires (W)"
          >
            Wire
          </button>
        </div>
      </div>

      <div className="sep" />

      <div className="group">
        <button className="btn" onClick={undo} disabled={s.past.length === 0} title="Undo">
          ↶
        </button>
        <button className="btn" onClick={redo} disabled={s.future.length === 0} title="Redo">
          ↷
        </button>
      </div>

      <div className="sep" />

      <div className="group">
        <span className="label">Side</span>
        <div className="switch">
          <button
            className={`switch-btn face ${s.side === 'top' ? 'active' : ''}`}
            onClick={() => set({ side: 'top' })}
            title="Top (Q)"
          >
            Top
          </button>
          <button
            className={`switch-btn face ${s.side === 'bottom' ? 'active' : ''}`}
            onClick={() => set({ side: 'bottom' })}
            title="Flip the board over — the view mirrors (E)"
          >
            Bottom
          </button>
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={s.showFarSide}
            onChange={(e) => set({ showFarSide: e.target.checked })}
          />
          ghost far side
        </label>
      </div>

      {(s.tool === 'wire' || s.selection.wires.length > 0) && (
        <>
          <div className="sep" />

          <div className="group">
            <span className="label">Wire</span>
            <div className="swatches">
              {WIRE_COLORS.map((c) => (
                <button
                  key={c.name}
                  className={`swatch ${s.wireColor === c.hex ? 'active' : ''}`}
                  style={{ background: c.hex }}
                  title={c.name}
                  onClick={() => {
                    set({ wireColor: c.hex })
                    // Recolour the current selection too, so you can restyle a
                    // wire after drawing it.
                    const sel = getState().selection.wires
                    if (sel.length) {
                      commit((p) =>
                        sel.reduce((acc, id) => updateWire(acc, id, { color: c.hex }), p),
                      )
                    }
                  }}
                />
              ))}
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={s.banded}
                onChange={(e) => {
                  set({ banded: e.target.checked })
                  const sel = getState().selection.wires
                  if (sel.length) {
                    commit((p) =>
                      sel.reduce((acc, id) => updateWire(acc, id, { banded: e.target.checked }), p),
                    )
                  }
                }}
              />
              banded
            </label>
          </div>
        </>
      )}
    </div>
  )
}

