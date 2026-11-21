// nexdiary mark: a quill drawing a line of ink, the ink and the dot as the accent. The source of every version is
// nexapps/icons-vergleich/neu.py; the same shape is in public/logo.svg (favicon) and scripts/app-icons.mjs (home
// screen and notifications). The colours come from index.css (--nd-logo-…) and follow the theme: a white tile in
// light mode, a dark one in dark mode. The wordmark's second half follows the theme's accent.
import { useId } from 'react'

export function LogoMark({ size = 36, className = '' }: { size?: number; className?: string }) {
  // One id per mark: a gradient whose first copy sits in a hidden part of the page draws nothing for the others.
  const id = `nd-mark-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const line = `url(#${id})`
  const ground = { fill: 'var(--nd-logo-ground)' }
  const ink = 'var(--nd-logo-ink)'
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
          <stop offset="0" style={{ stopColor: 'var(--nd-logo-gradient-1)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--nd-logo-gradient-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--nd-logo-gradient-3)' }} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" style={ground} />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.3" fill="none" strokeWidth="1.5" style={{ stroke: 'var(--nd-logo-rim)' }} />
      {/* the quill and its shaft */}
      <path
        d="M48 12c-12.5 1.5-21.5 9.5-25 22l-.5 7c6.2-1.5 12.4-5.6 16.5-11.3-2.9-.2-5.6 0-7.8.8 5.2-3.3 9.3-7.8 12.4-12.8 1.8-2.4 3.5-4.2 4.4-5.7z"
        stroke={line}
        strokeWidth="3.8"
        strokeLinejoin="round"
        style={ground}
      />
      <path d="M21.5 43.5 37 27" stroke={line} strokeWidth="3.2" strokeLinecap="round" />
      {/* the line of ink and the drop at the nib */}
      <path d="M12.5 52.5c6-2 10 2 16 0s9-3 15-1" fill="none" strokeWidth="3.6" strokeLinecap="round" style={{ stroke: ink }} />
      <circle cx="19.5" cy="46.5" r="3.8" strokeWidth="1.8" style={{ fill: ink, stroke: 'var(--nd-logo-ground)' }} />
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
