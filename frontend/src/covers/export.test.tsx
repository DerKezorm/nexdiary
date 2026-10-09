/**
 * The server draws the illustrations into the book ("Jahr als Buch") from `backend/app/assets/covers.json`: the same
 * drawings as SVG text. This test keeps that file in step with `drawings.tsx` and fails when they part. To write it
 * anew after a drawing changed:
 *
 *     UPDATE_COVERS=1 npx vitest run src/covers/export.test.tsx
 */
import { renderToStaticMarkup } from 'react-dom/server'

import stored from '../../../backend/app/assets/covers.json'
import { Illustration } from './drawings'
import { ALL_ILLUS } from './suggest'

const TARGET = '../../../backend/app/assets/covers.json'

/** One illustration as the server reads it: the SVG without what only the page needs (its name for screen readers),
 * and with ids that stay the same from one run to the next. */
function svgOf(id: string): string {
  const markup = renderToStaticMarkup(<Illustration id={id} />)
  const ids = new Map<string, string>()
  for (const match of markup.matchAll(/id="([^"]+)"/g)) if (!ids.has(match[1])) ids.set(match[1], `g${ids.size}`)
  let out = markup.replace(/ role="img"/, '').replace(/ aria-label="[^"]*"/, '').replace(/ class="[^"]*"/, '')
  for (const [from, to] of ids) out = out.split(`"${from}"`).join(`"${to}"`).split(`#${from})`).join(`#${to})`)
  return out
}

function all(): Record<string, string> {
  return Object.fromEntries([...ALL_ILLUS].sort().map((id) => [id, svgOf(id)]))
}

describe('the illustrations for the book', () => {
  it('lie on the server as they are drawn here', async () => {
    const made = all()
    const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    if (env?.UPDATE_COVERS === '1') {
      const fs = await import(/* @vite-ignore */ 'node:' + 'fs')
      const url = await import(/* @vite-ignore */ 'node:' + 'url')
      // One illustration per line: a changed drawing shows as its own lines changed.
      const lines = Object.entries(made).map(([id, svg]) => `${JSON.stringify(id)}:${JSON.stringify(svg)}`)
      fs.writeFileSync(url.fileURLToPath(new URL(TARGET, import.meta.url)), `{\n${lines.join(',\n')}\n}\n`)
    }
    expect(Object.keys(made)).toHaveLength(ALL_ILLUS.length)
    expect(stored).toEqual(made)
  })

  it('each have an id of their own and nothing that would reach outside', () => {
    const one = svgOf('kaffee.nacht.winter')
    expect(one).toContain('<svg')
    expect(one).not.toMatch(/href|<script|<image|aria-label/)
  })
})
