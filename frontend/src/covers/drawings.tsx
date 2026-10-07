/* eslint-disable react-refresh/only-export-components */
/**
 * The illustrations for days without a photo, drawn as in the mock (`attrappe/src/components/Illustration.tsx`): every
 * motif at four times of day and in four seasons. Which motifs exist, their group and whether they are indoors stands
 * in `catalog.json`; here is only how each one is drawn. A new motif: an entry in the catalog, a drawing here, its name
 * in the languages (`covers.motifs`). The tests find any of the three missing.
 */
import { useId, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { MOTIFS, SEASONS, TIMES, type Season, type Time } from './suggest'

type Pal = {
  ground: string
  ground2: string
  tree: string
  tree2: string
  bloom: string
  snow: boolean
  night: boolean
  dusk: boolean
  sun: string
}

const SKY: Record<Time, [string, string]> = {
  morgen: ['#f9d5c0', '#cfe3ee'],
  tag: ['#a7cde6', '#eaf2ef'],
  abend: ['#f2a679', '#7b4f79'],
  nacht: ['#1d2747', '#3b2f55'],
}
const GROUND: Record<Season, Omit<Pal, 'snow' | 'night' | 'dusk' | 'sun'>> = {
  fruehling: { ground: '#a9d08b', ground2: '#8cbc72', tree: '#7fb069', tree2: '#9cc785', bloom: '#f4a7b9' },
  sommer: { ground: '#8fbf5a', ground2: '#e2c25a', tree: '#4f8a3c', tree2: '#6aa04a', bloom: '#f2d16b' },
  herbst: { ground: '#c98a4b', ground2: '#b5693a', tree: '#d9692f', tree2: '#e8a33a', bloom: '#c4512a' },
  winter: { ground: '#eef2f5', ground2: '#d6dde5', tree: '#8d9aa6', tree2: '#b7c2cc', bloom: '#ffffff' },
}

type Drawing = (p: Pal, time: Time) => ReactNode

const Sun = ({ p, x, y, r = 12 }: { p: Pal; x: number; y: number; r?: number }) =>
  p.night ? (
    <>
      <circle cx={x} cy={y} r={r * 0.8} fill="#f4f1e1" />
      <circle cx={x + r * 0.35} cy={y - r * 0.2} r={r * 0.7} fill="#28304f" />
      {[
        [18, 14],
        [44, 26],
        [70, 10],
        [96, 22],
        [140, 16],
        [30, 36],
      ].map(([sx, sy]) => (
        <circle key={`${sx}`} cx={sx} cy={sy} r={0.9} fill="#fff" opacity={0.8} />
      ))}
    </>
  ) : (
    <circle cx={x} cy={y} r={r} fill={p.sun} opacity={0.95} />
  )

const Hills = ({ p, y = 78 }: { p: Pal; y?: number }) => (
  <>
    <path d={`M0 ${y} Q40 ${y - 12} 80 ${y - 4} T160 ${y - 6} V110 H0Z`} fill={p.ground2} />
    <path d={`M0 ${y + 10} Q60 ${y} 160 ${y + 12} V110 H0Z`} fill={p.ground} />
  </>
)

const Pine = ({ x, y, h, c }: { x: number; y: number; h: number; c: string }) => <path d={`M${x} ${y - h} L${x + h * 0.38} ${y} H${x - h * 0.38}Z`} fill={c} />

const RoundTree = ({ p, x, y, s = 1 }: { p: Pal; x: number; y: number; s?: number }) => (
  <g>
    <rect x={x - 2.5 * s} y={y - 18 * s} width={5 * s} height={20 * s} fill="#6b4630" />
    {p.snow ? (
      <>
        <path d={`M${x} ${y - 16 * s} l-9 ${-10 * s} M${x} ${y - 14 * s} l8 ${-12 * s} M${x} ${y - 20 * s} l1 ${-12 * s}`} stroke="#6b4630" strokeWidth={2 * s} strokeLinecap="round" />
        <ellipse cx={x} cy={y - 30 * s} rx={10 * s} ry={3 * s} fill="#fff" opacity={0.8} />
      </>
    ) : (
      <>
        <circle cx={x} cy={y - 28 * s} r={15 * s} fill={p.tree} />
        <circle cx={x - 11 * s} cy={y - 20 * s} r={9 * s} fill={p.tree2} />
        <circle cx={x + 11 * s} cy={y - 21 * s} r={9 * s} fill={p.tree} />
        {[
          [-6, -32],
          [5, -24],
          [9, -35],
          [-12, -22],
        ].map(([dx, dy]) => (
          <circle key={`${dx}${dy}`} cx={x + dx * s} cy={y + dy * s} r={1.8 * s} fill={p.bloom} />
        ))}
      </>
    )}
  </g>
)

const Window = ({ p, x, y, w, h, time }: { p: Pal; x: number; y: number; w: number; h: number; time: Time }) => {
  const id = useId().replace(/:/g, '')
  return (
    <g>
      <defs>
        <linearGradient id={`w${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={SKY[time][0]} />
          <stop offset="1" stopColor={SKY[time][1]} />
        </linearGradient>
        <clipPath id={`c${id}`}>
          <rect x={x} y={y} width={w} height={h} rx={3} />
        </clipPath>
      </defs>
      <rect x={x} y={y} width={w} height={h} rx={3} fill={`url(#w${id})`} />
      <g clipPath={`url(#c${id})`}>
        <path d={`M${x} ${y + h * 0.75} Q${x + w / 2} ${y + h * 0.6} ${x + w} ${y + h * 0.72} V${y + h} H${x}Z`} fill={p.ground} />
        {p.night && <circle cx={x + w * 0.75} cy={y + h * 0.25} r={3} fill="#f4f1e1" />}
        {!p.night && <circle cx={x + w * 0.3} cy={y + h * 0.3} r={4} fill={p.sun} />}
      </g>
      <path d={`M${x + w / 2} ${y} V${y + h} M${x} ${y + h / 2} H${x + w}`} stroke="#f6efe6" strokeWidth={2} />
      <rect x={x} y={y} width={w} height={h} rx={3} fill="none" stroke="#f6efe6" strokeWidth={3} />
    </g>
  )
}

const LIST: { id: string; draw: Drawing }[] = [
  {
    id: 'berge',
    draw: (p) => (
      <>
        <Sun p={p} x={112} y={30} />
        <path d="M0 64 L40 30 L70 56 L102 22 L160 66 V72 H0Z" fill="#7d93a6" />
        <path d="M94 30 L102 22 L111 31 L105 29 L100 33Z M34 35 L40 30 L46 36 L41 35Z" fill="#fff" opacity={p.snow ? 1 : 0.7} />
        <rect y={70} width={160} height={40} fill={p.snow ? '#9fb6c8' : '#6f9fbf'} />
        <path d="M20 84 h30 M70 94 h40 M112 82 h24" stroke="#d8ecf5" strokeWidth={2} strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'wald',
    draw: (p) => (
      <>
        <Sun p={p} x={128} y={24} r={10} />
        {[14, 40, 66, 92, 118, 144].map((x, i) => (
          <Pine key={x} x={x} y={92} h={48 + (i % 3) * 10} c={p.snow ? (i % 2 ? '#5f7a6a' : '#4c6658') : p.tree === '#d9692f' ? (i % 2 ? '#5a7a46' : '#c4512a') : i % 2 ? '#4f7a4a' : '#3d6340'} />
        ))}
        <rect y={90} width={160} height={20} fill={p.snow ? '#eef2f5' : '#6b5a3a'} />
      </>
    ),
  },
  {
    id: 'baum',
    draw: (p) => (
      <>
        <Sun p={p} x={124} y={28} />
        <Hills p={p} />
        <RoundTree p={p} x={52} y={78} s={1.15} />
      </>
    ),
  },
  {
    id: 'feld',
    draw: (p) => (
      <>
        <Sun p={p} x={36} y={30} />
        <path d="M0 60 Q80 48 160 62 V110 H0Z" fill={p.ground2} />
        <path d="M0 78 Q80 66 160 82 V110 H0Z" fill={p.ground} />
        {[0, 1, 2, 3, 4].map((i) => (
          <path key={i} d={`M${-10 + i * 40} 110 Q${30 + i * 30} 86 ${70 + i * 20} 74`} stroke={p.ground2} strokeWidth={1.5} fill="none" opacity={0.7} />
        ))}
        <RoundTree p={p} x={124} y={64} s={0.6} />
      </>
    ),
  },
  {
    id: 'weg',
    draw: (p) => (
      <>
        <Sun p={p} x={80} y={40} />
        <Hills p={p} y={66} />
        <path d="M70 110 C78 92 96 86 84 76 C76 70 82 64 86 62" stroke={p.snow ? '#c9d3dc' : '#e8d3a9'} strokeWidth={10} fill="none" strokeLinecap="round" />
        <RoundTree p={p} x={28} y={84} s={0.7} />
        <RoundTree p={p} x={136} y={80} s={0.55} />
      </>
    ),
  },
  {
    id: 'garten',
    draw: (p) => (
      <>
        <Sun p={p} x={120} y={26} />
        <rect y={78} width={160} height={32} fill={p.ground} />
        <path d="M0 74 h160" stroke="#b08a63" strokeWidth={3} />
        {[10, 30, 50, 70, 90, 110, 130, 150].map((x) => (
          <rect key={x} x={x - 1.5} y={62} width={3} height={16} fill="#b08a63" />
        ))}
        {p.snow ? (
          <g>
            <circle cx={58} cy={92} r={10} fill="#fff" />
            <circle cx={58} cy={76} r={7} fill="#fff" />
            <path d="M58 76 l5 1" stroke="#e8a33a" strokeWidth={2} />
            <circle cx={56} cy={74} r={0.9} fill="#333" />
          </g>
        ) : (
          [16, 34, 52, 70, 88, 106, 124, 142].map((x, i) => (
            <g key={x}>
              <path d={`M${x} 100 V${86 - (i % 3) * 4}`} stroke={p.tree} strokeWidth={2} />
              <circle cx={x} cy={84 - (i % 3) * 4} r={4.5} fill={i % 2 ? p.bloom : p.tree2} />
            </g>
          ))
        )}
      </>
    ),
  },
  {
    id: 'zelt',
    draw: (p) => (
      <>
        <Sun p={p} x={130} y={26} r={10} />
        <Hills p={p} y={74} />
        <path d="M30 92 L52 56 L74 92Z" fill="#c4682f" />
        <path d="M52 56 L60 92 H44Z" fill="#8f4519" />
        <path d="M100 96 l8 -4 l8 4" stroke="#6b4630" strokeWidth={3} strokeLinecap="round" />
        <path d="M108 92 q-6 -8 0 -16 q6 8 0 16Z" fill="#f2a03a" />
        {(p.night || p.dusk) && <circle cx={108} cy={88} r={18} fill="#f2a03a" opacity={0.18} />}
      </>
    ),
  },
  {
    id: 'strand',
    draw: (p) => (
      <>
        <Sun p={p} x={124} y={30} />
        <rect y={58} width={160} height={24} fill={p.snow ? '#7f9cae' : '#5fb1c7'} />
        <path d="M0 64 q10 -3 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" stroke="#d8ecf5" strokeWidth={1.5} fill="none" opacity={0.8} />
        <path d="M0 80 Q80 70 160 82 V110 H0Z" fill={p.snow ? '#e3e7ea' : '#f2d39b'} />
        {!p.snow && (
          <g>
            <path d="M46 92 V64" stroke="#8a6a50" strokeWidth={2} />
            <path d="M28 66 Q46 50 64 66Z" fill="#e66a4f" />
          </g>
        )}
      </>
    ),
  },
  {
    id: 'boot',
    draw: (p) => (
      <>
        <Sun p={p} x={36} y={30} />
        <path d="M0 66 Q50 56 100 64 T160 60 V70 H0Z" fill={p.ground2} />
        <rect y={68} width={160} height={42} fill={p.snow ? '#9fb6c8' : '#6f9fbf'} />
        <path d="M84 84 L84 44 L106 82Z" fill="#fffaf2" />
        <path d="M82 50 L82 82 L66 80Z" fill="#f0e2cf" />
        <path d="M64 86 H112 L104 94 H72Z" fill="#8a5a3c" />
        <path d="M20 100 h24 M120 98 h22" stroke="#d8ecf5" strokeWidth={2} strokeLinecap="round" />
      </>
    ),
  },
  {
    id: 'leuchtturm',
    draw: (p) => (
      <>
        <Sun p={p} x={36} y={28} r={10} />
        <rect y={74} width={160} height={36} fill={p.snow ? '#9fb6c8' : '#6f9fbf'} />
        <path d="M86 110 L96 70 Q120 60 160 66 V110Z" fill={p.ground2} />
        <path d="M116 72 L120 32 H130 L134 72Z" fill="#fffaf2" />
        <path d="M117 60 H133 M118 48 H132" stroke="#d9534f" strokeWidth={5} />
        <rect x={118} y={24} width={14} height={9} rx={2} fill={p.night || p.dusk ? '#ffe08a' : '#cfd8de'} />
        {(p.night || p.dusk) && <path d="M118 28 L40 14 L40 40Z" fill="#ffe08a" opacity={0.22} />}
      </>
    ),
  },
  {
    id: 'haus',
    draw: (p) => (
      <>
        <Sun p={p} x={128} y={26} r={10} />
        <Hills p={p} y={74} />
        <rect x={52} y={56} width={48} height={34} fill="#efe2cf" />
        <path d="M46 58 L76 36 L106 58Z" fill="#b8562f" />
        {p.snow && <path d="M46 58 L76 36 L106 58 L100 58 L76 41 L52 58Z" fill="#fff" />}
        <rect x={90} y={38} width={6} height={12} fill="#8f4519" />
        <path d="M93 34 q-4 -6 2 -10 q-6 -4 0 -10" stroke="#f6efe6" strokeWidth={2} fill="none" opacity={0.7} />
        <rect x={60} y={64} width={11} height={10} fill={p.night || p.dusk ? '#ffd27a' : '#a8c6d8'} />
        <rect x={81} y={64} width={11} height={10} fill={p.night || p.dusk ? '#ffd27a' : '#a8c6d8'} />
        <rect x={71} y={74} width={10} height={16} fill="#8a5a3c" />
      </>
    ),
  },
  {
    id: 'stadt',
    draw: (p) => (
      <>
        <Sun p={p} x={30} y={26} r={10} />
        {[
          [8, 44, 24],
          [34, 28, 20],
          [56, 52, 26],
          [84, 20, 22],
          [108, 46, 20],
          [130, 34, 24],
        ].map(([x, y, w], i) => (
          <g key={x}>
            <rect x={x} y={y} width={w} height={110 - y} fill={p.night ? '#3d3a52' : i % 2 ? '#8a7f9c' : '#9c90ac'} />
            {Array.from({ length: Math.floor((96 - y) / 10) }, (_, r) => (
              <g key={r}>
                <rect x={x + 4} y={y + 6 + r * 10} width={4} height={4} fill={p.night || p.dusk ? ((r + i) % 3 ? '#ffd27a' : '#55506a') : '#c8d4e2'} />
                <rect x={x + w - 8} y={y + 6 + r * 10} width={4} height={4} fill={p.night || p.dusk ? ((r + i) % 2 ? '#ffd27a' : '#55506a') : '#c8d4e2'} />
              </g>
            ))}
          </g>
        ))}
        <rect y={96} width={160} height={14} fill={p.snow ? '#e3e7ea' : '#5c556b'} />
      </>
    ),
  },
  {
    id: 'kaffee',
    draw: (p, time) => (
      <>
        <rect width={160} height={110} fill="#e9dcc9" />
        <Window p={p} x={88} y={12} w={56} h={52} time={time} />
        <rect y={76} width={160} height={34} fill="#9c7350" />
        <ellipse cx={58} cy={78} rx={30} ry={7} fill="#f6efe6" />
        <path d="M40 58 h36 v14 a18 12 0 0 1 -36 0Z" fill="#f6efe6" />
        <ellipse cx={58} cy={58} rx={18} ry={4} fill="#5a3825" />
        <path d="M76 62 q10 0 8 8 q-2 5 -8 3" stroke="#f6efe6" strokeWidth={3.5} fill="none" />
        <path d="M52 48 q-4 -7 2 -12 M64 48 q-4 -7 2 -12" stroke="#fff" strokeWidth={1.8} fill="none" opacity={0.7} />
      </>
    ),
  },
  {
    id: 'buch',
    draw: (p, time) => (
      <>
        <rect width={160} height={110} fill="#e7dcce" />
        <Window p={p} x={14} y={12} w={52} h={50} time={time} />
        <rect y={80} width={160} height={30} fill="#8b6a4f" />
        <path d="M70 80 c10 -6 22 -6 32 0 v-24 c-10 -6 -22 -6 -32 0Z" fill="#fffaf2" />
        <path d="M134 80 c-10 -6 -22 -6 -32 0 v-24 c10 -6 22 -6 32 0Z" fill="#f3e7d6" />
        <path d="M128 80 V44 M120 80 h16" stroke="#5a4636" strokeWidth={2.5} strokeLinecap="round" />
        <path d="M117 44 h22 l-5 -14 h-12Z" fill={p.night || p.dusk ? '#ffd27a' : '#d9c8b0'} stroke="#5a4636" strokeWidth={1.5} strokeLinejoin="round" />
        {(p.night || p.dusk) && <circle cx={128} cy={50} r={26} fill="#ffd27a" opacity={0.18} />}
      </>
    ),
  },
  {
    id: 'kuchen',
    draw: (p, time) => (
      <>
        <rect width={160} height={110} fill="#efe1d6" />
        <Window p={p} x={100} y={10} w={46} h={44} time={time} />
        <rect y={82} width={160} height={28} fill="#a07a5c" />
        <rect x={48} y={58} width={56} height={24} rx={4} fill="#f6d7c8" />
        <rect x={48} y={58} width={56} height={7} rx={3} fill="#fffaf2" />
        {[60, 76, 92].map((x) => (
          <g key={x}>
            <rect x={x - 1.5} y={46} width={3} height={12} fill="#7fb3d5" />
            <path d={`M${x} 46 q-3 -4 0 -8 q3 4 0 8Z`} fill="#f2a03a" />
          </g>
        ))}
        {[
          [20, 20, '#e66a4f'],
          [36, 36, '#7fb3d5'],
          [14, 50, '#f2d16b'],
          [72, 20, '#9cc785'],
          [86, 34, '#e66a4f'],
        ].map(([x, y, c]) => (
          <rect key={`${x}`} x={x as number} y={y as number} width={4} height={2} fill={c as string} transform={`rotate(30 ${x} ${y})`} />
        ))}
      </>
    ),
  },
  {
    id: 'regen',
    draw: (p) => (
      <>
        <rect width={160} height={110} fill={p.night ? '#2a3045' : '#9aa6b2'} opacity={0.55} />
        <ellipse cx={56} cy={24} rx={34} ry={12} fill={p.night ? '#4a5168' : '#e4e8ec'} />
        <ellipse cx={104} cy={30} rx={30} ry={11} fill={p.night ? '#3f465d' : '#d6dce2'} />
        <Hills p={p} y={84} />
        {Array.from({ length: 16 }, (_, i) =>
          p.snow ? (
            <circle key={i} cx={8 + i * 10} cy={44 + ((i * 13) % 34)} r={1.6} fill="#fff" />
          ) : (
            <path key={i} d={`M${10 + i * 10} ${44 + ((i * 13) % 30)} l-4 9`} stroke="#eef3f7" strokeWidth={1.8} strokeLinecap="round" />
          ),
        )}
      </>
    ),
  },
]


/** How each motif is drawn, by its id. */
export const DRAWINGS: Record<string, Drawing> = Object.fromEntries(LIST.map((entry) => [entry.id, entry.draw]))

/** "Berge am See, Abend, Herbst": the name of an illustration in the language of the page. */
export function useIlluName(): (id: string) => string {
  const { t } = useTranslation()
  return (id: string) => {
    const [motif, time, season] = id.split('.')
    return `${t(`covers.motifs.${motif}`)}, ${t(`covers.times.${time}`)}, ${t(`covers.seasons.${season}`)}`
  }
}

export function Illustration({ id, className = '' }: { id: string; className?: string }) {
  const name = useIlluName()
  const [m, t, s] = id.split('.') as [string, Time, Season]
  const motif = MOTIFS.find((x) => x.id === m) ?? MOTIFS.find((x) => x.id === 'baum')!
  const time: Time = TIMES.includes(t) ? t : 'tag'
  const season: Season = SEASONS.includes(s) ? s : 'sommer'
  const gid = useId().replace(/:/g, '')
  const pal: Pal = {
    ...GROUND[season],
    snow: season === 'winter',
    night: time === 'nacht',
    dusk: time === 'abend',
    sun: time === 'abend' ? '#ffcf8a' : time === 'morgen' ? '#fff1d6' : '#fff6dc',
  }
  const [a, b] = SKY[time]
  const draw = DRAWINGS[motif.id] ?? DRAWINGS.baum
  return (
    <svg viewBox="0 0 160 110" preserveAspectRatio="xMidYMid slice" className={className} role="img" aria-label={name(`${motif.id}.${time}.${season}`)}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={a} />
          <stop offset="1" stopColor={b} />
        </linearGradient>
      </defs>
      <rect width={160} height={110} fill={`url(#${gid})`} />
      {draw(pal, time)}
      {!motif.indoor && time === 'nacht' && <rect width={160} height={110} fill="#0d1330" opacity={0.28} />}
      {!motif.indoor && time === 'abend' && <rect width={160} height={110} fill="#7a2f4a" opacity={0.1} />}
      {motif.indoor && time === 'nacht' && <rect width={160} height={110} fill="#1b1430" opacity={0.18} />}
    </svg>
  )
}
