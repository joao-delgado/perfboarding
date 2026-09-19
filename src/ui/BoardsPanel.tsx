import { BOARD_EDGES, hasPadEdge, padCount, togglePadEdge } from '../model/pads'
import { addBoard, removeBoard, updateBoard } from '../model/project'
import { commit, set, useEditor } from '../model/store'
import { MAX_DIM, MIN_DIM, type BoardEdge } from '../model/types'
import { Section } from './Section'

function clamp(n: number): number {
  if (!Number.isFinite(n)) return MIN_DIM
  return Math.max(MIN_DIM, Math.min(MAX_DIM, Math.round(n)))
}

const EDGE_LABEL: Record<BoardEdge, string> = { left: 'L', top: 'T', bottom: 'B', right: 'R' }

export function BoardsPanel() {
  const s = useEditor()
  const boards = s.project.boards

  return (
    <Section
      id="boards"
      title="Boards"
      defaultHeight={200}
      headerExtra={
        <button className="btn small" onClick={() => commit((p) => addBoard(p))}>
          + Add
        </button>
      }
    >
      <div className="boards-list">
        {boards.map((b) => {
          const selected = s.selection.boards.includes(b.id)
          const holes = b.cols * b.rows
          const pads = padCount(b)
          return (
            <div
              key={b.id}
              className={`board-row ${selected ? 'sel' : ''}`}
              onClick={() => set({ selection: { parts: [], wires: [], boards: [b.id] } })}
            >
              <div className="board-row-top">
                <input
                  className="board-name"
                  value={b.name}
                  onChange={(e) => commit((p) => updateBoard(p, b.id, { name: e.target.value }))}
                />
                <button
                  className="btn small"
                  disabled={boards.length <= 1}
                  title={boards.length <= 1 ? 'A project needs at least one board' : 'Remove board'}
                  onClick={(e) => {
                    e.stopPropagation()
                    commit((p) => removeBoard(p, b.id))
                  }}
                >
                  ×
                </button>
              </div>
              <div className="board-row-dims">
                <input
                  className="num"
                  type="number"
                  min={MIN_DIM}
                  max={MAX_DIM}
                  value={b.cols}
                  onChange={(e) =>
                    commit((p) => updateBoard(p, b.id, { cols: clamp(Number(e.target.value)) }))
                  }
                />
                <span className="times">×</span>
                <input
                  className="num"
                  type="number"
                  min={MIN_DIM}
                  max={MAX_DIM}
                  value={b.rows}
                  onChange={(e) =>
                    commit((p) => updateBoard(p, b.id, { rows: clamp(Number(e.target.value)) }))
                  }
                />
                <input
                  type="color"
                  value={b.color}
                  title="Board colour"
                  onChange={(e) => commit((p) => updateBoard(p, b.id, { color: e.target.value }))}
                />
                <input
                  type="color"
                  value={b.padColor}
                  title="Pad ring colour"
                  onChange={(e) => commit((p) => updateBoard(p, b.id, { padColor: e.target.value }))}
                />
              </div>
              {/* Edge pads: the oblong bus pads down the sides of a protoboard.
                  They sit OUTSIDE the hole lattice, so switching one on grows
                  the board rather than consuming a column you built on. */}
              <div className="board-row-pads" onClick={(e) => e.stopPropagation()}>
                <span className="lbl" title="Oblong two-hole bus pads along the board edges">
                  Edge pads
                </span>
                <div className="pad-edges">
                  {BOARD_EDGES.map((edge) => (
                    <button
                      key={edge}
                      className={`btn small ${hasPadEdge(b.padEdges, edge) ? 'active' : ''}`}
                      title={`${edge[0].toUpperCase()}${edge.slice(1)} edge pads`}
                      onClick={() =>
                        commit((p) =>
                          updateBoard(p, b.id, { padEdges: togglePadEdge(b.padEdges, edge) }),
                        )
                      }
                    >
                      {EDGE_LABEL[edge]}
                    </button>
                  ))}
                </div>
              </div>
              {pads > 0 && <div className="board-note">{pads} edge pads</div>}
              {holes > 2000 && (
                <div className="board-warn">{holes.toLocaleString()} holes — may render slowly</div>
              )}
            </div>
          )
        })}
      </div>
    </Section>
  )
}
