/**
 * The cover of a day, as a name: `illu:<motif>.<time>.<season>` for one of the illustrations, `photo:<id>` for an own
 * photo. The lists come from `catalog.json`, which the server mirrors (`backend/app/services/covers.py`; a test on
 * each side compares them). A new motif: an entry there, its drawing in `drawings.tsx`, its names in the languages.
 */
import catalog from './catalog.json'

export type Time = 'morgen' | 'tag' | 'abend' | 'nacht'
export type Season = 'fruehling' | 'sommer' | 'herbst' | 'winter'
export type Motif = { id: string; group: string; indoor?: boolean }

export const TIMES = catalog.times as Time[]
export const SEASONS = catalog.seasons as Season[]
export const GROUPS = catalog.groups
export const MOTIFS = catalog.motifs as Motif[]
const DEFAULTS = catalog.defaults
const TAG_MOTIFS = catalog.tagMotifs as [string, string][]
export const SUGGESTIONS = 6

/** Every illustration there is: each motif at four times of day and in four seasons. */
export const ALL_ILLUS: string[] = MOTIFS.flatMap((motif) => TIMES.flatMap((time) => SEASONS.map((season) => `${motif.id}.${time}.${season}`)))

export const ILLU = 'illu:'
export const PHOTO = 'photo:'

/** The season of a `YYYY-MM-DD` (the northern one, as the illustrations are drawn). */
export function seasonOf(date: string): Season {
  const month = Number(date.slice(5, 7))
  return month >= 3 && month <= 5 ? 'fruehling' : month >= 6 && month <= 8 ? 'sommer' : month >= 9 && month <= 11 ? 'herbst' : 'winter'
}

/** The time of day of an hour: morning until eleven, the day until six, the evening until ten, then the night. */
export function timeOfHour(hour: number): Time {
  return hour >= 5 && hour < 11 ? 'morgen' : hour >= 11 && hour < 18 ? 'tag' : hour >= 18 && hour < 22 ? 'abend' : 'nacht'
}

/** The illustrations that fit a day, best first: the motifs its tags call for, then the usual ones. The evening when
 * nothing else is said, since that is when one writes. */
export function suggestIllus(date: string, tags: string[], time: Time = 'abend'): string[] {
  const season = seasonOf(date)
  const motifs: string[] = []
  for (const [tag, motif] of TAG_MOTIFS) if (tags.includes(tag) && !motifs.includes(motif)) motifs.push(motif)
  for (const motif of DEFAULTS) if (!motifs.includes(motif)) motifs.push(motif)
  return motifs.slice(0, SUGGESTIONS).map((motif) => `${motif}.${time}.${season}`)
}

export function isIllustration(cover: string | null | undefined): cover is string {
  return typeof cover === 'string' && cover.startsWith(ILLU) && ALL_ILLUS.includes(cover.slice(ILLU.length))
}

/** The photo id of a cover, or null. */
export function photoOf(cover: string | null | undefined): string | null {
  return typeof cover === 'string' && /^photo:[0-9a-f]{32}$/.test(cover) ? cover.slice(PHOTO.length) : null
}

export function motifOf(id: string): Motif | undefined {
  return MOTIFS.find((motif) => motif.id === id.split('.')[0])
}
