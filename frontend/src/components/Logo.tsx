// nexdiary mark: a quill drawing a line, in the style of the nexapps marks (dark tile, light line art in a gradient,
// as nexlore's). The mark stays sage in every theme; the wordmark's second half follows the theme's accent.
import { useId } from 'react'

export function LogoMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  // userSpaceOnUse, so the gradient runs across the whole mark instead of restarting for each stroke.
  const id = useId().replace(/:/g, '')
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="56" y2="56">
          <stop offset="0" stopColor="#eef5ea" />
          <stop offset=".5" stopColor="#98bb8e" />
          <stop offset="1" stopColor="#4a6a43" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#0e140d" />
      <rect x="2" y="2" width="60" height="60" rx="16" fill="none" stroke={`url(#${id})`} strokeWidth="2.5" strokeOpacity=".55" />
      <path
        d="M47 13c-12 1.5-21 9.5-24.5 21.5L22 41c6-1.5 12-5.5 16-11-2.8-.2-5.4 0-7.6.8 5-3.2 9-7.6 12-12.4 1.8-2.4 3.4-4 4.6-5.4z"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth="2.8"
        strokeLinejoin="round"
        strokeOpacity=".85"
      />
      <path d="M22 42 36 27" fill="none" stroke={`url(#${id})`} strokeWidth="2.6" strokeLinecap="round" strokeOpacity=".7" />
      <path d="M13 52c6-2 10 2 16 0s9-3 15-1" fill="none" stroke={`url(#${id})`} strokeWidth="2.6" strokeLinecap="round" strokeOpacity=".7" />
      <circle cx="19.5" cy="46" r="3.6" fill="#98bb8e" />
    </svg>
  )
}

export function Wordmark({ size = 34 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark size={size} />
      <span className="text-lg font-extrabold tracking-tight text-ink">
        NEX<span className="text-accent">DIARY</span>
      </span>
    </span>
  )
}
