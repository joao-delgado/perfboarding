import type { ReactNode } from 'react'
import { InfoIcon } from './ToolIcons'

/**
 * A hover-revealed info card, for instructions that used to sit as a
 * permanent block of text in the sidebar. Pure CSS (`:hover`/`:focus-within`)
 * so it needs no open/close state and can't get stuck open when the mouse
 * moves elsewhere.
 */
export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <span className="info-tip" tabIndex={0}>
      <InfoIcon />
      <span className="info-tip-pop">{children}</span>
    </span>
  )
}
