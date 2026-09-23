/**
 * Small monochrome tool icons for the part editor's tool rows. Each is a
 * fixed 15×15 viewBox so they line up regardless of which glyph is drawn;
 * colour comes from `currentColor`, so a `.btn.active` (white-on-blue) needs
 * no icon-specific CSS.
 */

type IconProps = { size?: number }

const box = (size: number, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    {children}
  </svg>
)

export function SelectIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <path
      d="M3 2 L3 12.5 L5.8 9.9 L7.6 13.2 L9.1 12.4 L7.3 9.1 L11 8.7 Z"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth={0.6}
      strokeLinejoin="round"
    />,
  )
}

export function PenIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <>
      <circle cx={3} cy={3} r={1.1} fill="currentColor" />
      <circle cx={7.5} cy={5.5} r={1.1} fill="none" stroke="currentColor" strokeWidth={1.1} />
      <circle cx={12} cy={3} r={1.1} fill="currentColor" />
      <path d="M3 3 C 4.5 7, 6 7, 7.5 5.5 C 9 4, 10.5 7, 12 3" stroke="currentColor" strokeWidth={1.1} fill="none" />
    </>,
  )
}

export function LineIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <path d="M2.5 12.5 L12.5 2.5" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" />,
  )
}

export function RectIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <rect x={2.2} y={3.6} width={10.6} height={7.8} rx={0.6} fill="none" stroke="currentColor" strokeWidth={1.4} />,
  )
}

export function EllipseIcon({ size = 15 }: IconProps) {
  return box(size, <circle cx={7.5} cy={7.5} r={5.1} fill="none" stroke="currentColor" strokeWidth={1.4} />)
}

export function TextIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <path
      d="M2.6 3.3 H12.4 M7.5 3.3 V12.2 M5.2 12.2 H9.8"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
    />,
  )
}

export function InfoIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <>
      <circle cx={7.5} cy={7.5} r={6.2} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <circle cx={7.5} cy={4.6} r={0.9} fill="currentColor" />
      <path d="M7.5 6.9 V11" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" />
    </>,
  )
}

export function EyeIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <>
      <path
        d="M1.3 7.5 C 3.6 3.6, 11.4 3.6, 13.7 7.5 C 11.4 11.4, 3.6 11.4, 1.3 7.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <circle cx={7.5} cy={7.5} r={1.9} fill="currentColor" />
    </>,
  )
}

export function EyeOffIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <>
      <path
        d="M1.3 7.5 C 3.6 3.6, 11.4 3.6, 13.7 7.5 C 11.4 11.4, 3.6 11.4, 1.3 7.5 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        strokeLinejoin="round"
      />
      <circle cx={7.5} cy={7.5} r={1.9} fill="none" stroke="currentColor" strokeWidth={1.1} />
      <path d="M2.4 12.6 L12.6 2.4" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </>,
  )
}

/** Right-hand sidebar, for the mobile drawer toggle. */
export function PanelIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <>
      <rect x={1.2} y={2.2} width={12.6} height={10.6} rx={1.6} fill="none" stroke="currentColor" strokeWidth={1.2} />
      <path d="M9.2 2.2 L9.2 12.8" stroke="currentColor" strokeWidth={1.2} />
      <path d="M11 5.4 H12.3 M11 7.5 H12.3 M11 9.6 H12.3" stroke="currentColor" strokeWidth={1.1} strokeLinecap="round" />
    </>,
  )
}

export function CloseIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <path
      d="M3.4 3.4 L11.6 11.6 M11.6 3.4 L3.4 11.6"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
    />,
  )
}

/** Arrows pointing into the corners: re-frame the whole build. */
export function FitIcon({ size = 15 }: IconProps) {
  return box(
    size,
    <g stroke="currentColor" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <path d="M1.6 5 V1.6 H5" />
      <path d="M10 1.6 H13.4 V5" />
      <path d="M13.4 10 V13.4 H10" />
      <path d="M5 13.4 H1.6 V10" />
      <rect x={4.8} y={4.8} width={5.4} height={5.4} rx={0.8} />
    </g>,
  )
}
