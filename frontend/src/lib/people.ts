import type { Person } from '../api/client'

/** How a person is called in the interface: the shown name, else the name to sign in with. */
export function nameOf(person: Pick<Person, 'name' | 'display_name'>): string {
  return person.display_name || person.name
}
