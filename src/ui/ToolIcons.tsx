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
