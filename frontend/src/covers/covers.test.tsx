/**
 * The illustrations: every motif at four times and in four seasons, each id once, each one drawn and named in both
 * languages, and a suggestion for every day of the year at every time of day. The cases in `suggest.cases.json` are
 * run on the server too (`backend/tests/test_covers.py`), so both pick the same pictures.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'

import de from '../i18n/de.json'
import en from '../i18n/en.json'
import i18n from '../i18n'
import catalog from './catalog.json'
import cases from './suggest.cases.json'
import { DRAWINGS, Illustration } from './drawings'
import { ALL_ILLUS, GROUPS, isIllustration, MOTIFS, photoOf, SEASONS, seasonOf, suggestIllus, SUGGESTIONS, TIMES, timeOfHour, type Time } from './suggest'

describe('the illustrations', () => {
  it('are every motif at every time of day in every season, each once', () => {
    expect(MOTIFS.length).toBeGreaterThanOrEqual(16)
    expect(ALL_ILLUS).toHaveLength(MOTIFS.length * TIMES.length * SEASONS.length)
    expect(ALL_ILLUS).toHaveLength(MOTIFS.length * 16)
    expect(new Set(ALL_ILLUS).size).toBe(ALL_ILLUS.length)
    expect(new Set(MOTIFS.map((motif) => motif.id)).size).toBe(MOTIFS.length)
  })

  it('have a drawing for every motif of the catalog and none without one', () => {
    expect(Object.keys(DRAWINGS).sort()).toEqual(MOTIFS.map((motif) => motif.id).sort())
    for (const motif of MOTIFS) expect(GROUPS).toContain(motif.group)
  })

  it('are named in both languages', () => {
    for (const texts of [de, en]) {
      for (const motif of MOTIFS) expect(texts.covers.motifs[motif.id as keyof typeof texts.covers.motifs]).toBeTruthy()
      for (const group of GROUPS) expect(texts.covers.groups[group as keyof typeof texts.covers.groups]).toBeTruthy()
      for (const time of TIMES) expect(texts.covers.times[time]).toBeTruthy()
      for (const season of SEASONS) expect(texts.covers.seasons[season]).toBeTruthy()
    }
  })

  it('each render as a picture with its name', () => {
    void i18n.changeLanguage('de')
    const names = new Set<string>()
    for (const id of ALL_ILLUS) {
      const markup = renderToStaticMarkup(
        <I18nextProvider i18n={i18n}>
          <Illustration id={id} />
        </I18nextProvider>,
      )
      const label = /aria-label="([^"]+)"/.exec(markup)?.[1] ?? ''
      expect(markup.startsWith('<svg')).toBe(true)
      expect(label.split(', ')).toHaveLength(3)
      // More than the sky: the motif draws something of its own.
      expect((markup.match(/<(path|circle|rect|ellipse|g)\b/g) ?? []).length).toBeGreaterThan(2)
      names.add(label)
    }
    expect(names.size).toBe(ALL_ILLUS.length)
  })
})

describe('the suggestion', () => {
  it.each(cases)('follows season, time and tags: $date $time', ({ date, tags, time, expect: motifs, season }) => {
    expect(suggestIllus(date, tags, time as Time)).toEqual(motifs.map((motif) => `${motif}.${time}.${season}`))
  })

  it('is never empty, on any day of a leap year at any time', () => {
    const day = new Date(Date.UTC(2028, 0, 1))
    while (day.getUTCFullYear() === 2028) {
      const date = day.toISOString().slice(0, 10)
      for (const time of TIMES) {
        const got = suggestIllus(date, ['urlaub'], time)
        expect(got).toHaveLength(SUGGESTIONS)
        expect(new Set(got).size).toBe(SUGGESTIONS)
        for (const id of got) expect(ALL_ILLUS).toContain(id)
      }
      day.setUTCDate(day.getUTCDate() + 1)
    }
  })

  it('turns the season at the edge of the month', () => {
    expect([seasonOf('2026-02-28'), seasonOf('2026-03-01'), seasonOf('2026-05-31'), seasonOf('2026-06-01')]).toEqual(['winter', 'fruehling', 'fruehling', 'sommer'])
    expect([seasonOf('2026-08-31'), seasonOf('2026-09-01'), seasonOf('2026-11-30'), seasonOf('2026-12-01')]).toEqual(['sommer', 'herbst', 'herbst', 'winter'])
  })

  it('turns the time of day at the edge of the hour', () => {
    expect([4, 5, 10, 11, 17, 18, 21, 22, 0].map(timeOfHour)).toEqual(['nacht', 'morgen', 'morgen', 'tag', 'tag', 'abend', 'abend', 'nacht', 'nacht'])
  })

  it('uses the lists the server mirrors', () => {
    expect(TIMES).toEqual(catalog.times)
    expect(SEASONS).toEqual(catalog.seasons)
  })
})

describe('a cover name', () => {
  it('is an illustration only when it is a known one, a photo only with a whole id', () => {
    expect(isIllustration('illu:baum.abend.herbst')).toBe(true)
    for (const wrong of ['baum.abend.herbst', 'illu:mond.abend.herbst', 'illu:baum.abend', null, undefined, '']) expect(isIllustration(wrong)).toBe(false)
    expect(photoOf(`photo:${'a'.repeat(32)}`)).toBe('a'.repeat(32))
    for (const wrong of ['photo:../x', `photo:${'A'.repeat(32)}`, 'illu:baum.abend.herbst', null]) expect(photoOf(wrong)).toBeNull()
  })
})
