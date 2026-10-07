/** Text shared from another app lands in the quick note once, title, text and link without repeats. */
import { sharedText } from './shared'

describe('what another app shared', () => {
  it('takes the text alone', () => {
    expect(sharedText('?text=mittag%20im%20park')).toBe('mittag im park')
  })

  it('puts title, text and link together, each once', () => {
    expect(sharedText('?title=Kastanien&text=Schau%20mal&url=https%3A%2F%2Fexample.com%2Fa')).toBe('Kastanien\nSchau mal\nhttps://example.com/a')
    expect(sharedText('?text=Schau%20mal%20https%3A%2F%2Fexample.com%2Fa&url=https%3A%2F%2Fexample.com%2Fa')).toBe('Schau mal https://example.com/a')
    expect(sharedText('?title=Schau&text=Schau')).toBe('Schau')
  })

  it('is empty without anything shared and never longer than a note', () => {
    expect(sharedText('')).toBe('')
    expect(sharedText('?text=' + 'a'.repeat(6000))).toHaveLength(5000)
  })
})
