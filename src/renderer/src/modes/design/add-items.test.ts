// Add lists in parity with the core (hardening DF98): every design add command of the project
// registry is an Add item or named in NOT_ADDED with where it is offered instead; every item's
// command exists; each surface offers every item unless ADD_EXCEPTIONS says why not. The rendered
// surfaces are compared in Design.test.tsx ("every Add list offers the same items").
// Doc: docs/conventions/ui.md#add-lists-df98
import { describe, expect, it } from 'vitest'
import { PROJECT_COMMANDS } from '../../../../core/commands/registry'
import {
  ADD_EXCEPTIONS,
  ADD_ITEMS,
  addItemLabel,
  addItemsFor,
  NOT_ADDED,
  type AddSurface,
} from './add-items'

const SURFACES: readonly AddSurface[] = ['menu', 'empty', 'face']
const addCommands = PROJECT_COMMANDS.map((c) => c.name).filter((n) =>
  /^design\.[a-zA-Z]+\.add$/.test(n),
)

describe('Add items (DF98)', () => {
  it('every design add command is an Add item or explicitly offered elsewhere', () => {
    const items = new Set(ADD_ITEMS.map((i) => i.command))
    const missing = addCommands.filter((n) => !items.has(n) && NOT_ADDED[n] === undefined)
    expect(missing).toEqual([])
  })

  it('every item and every exception names a registered command', () => {
    const known = new Set(addCommands)
    for (const i of ADD_ITEMS) expect(known.has(i.command), i.command).toBe(true)
    for (const n of Object.keys(NOT_ADDED)) expect(known.has(n), n).toBe(true)
  })

  it('every surface offers every item, in one order, unless an exception says why', () => {
    for (const s of SURFACES) {
      const left = ADD_ITEMS.filter((i) => !addItemsFor(s).includes(i)).map((i) => i.id)
      expect(left, s).toEqual(Object.keys(ADD_EXCEPTIONS[s]))
      for (const why of Object.values(ADD_EXCEPTIONS[s])) expect(why, s).toMatch(/\S/)
    }
    // today no surface leaves anything out: Pattern was missing from the empty list and the face
    expect(SURFACES.map((s) => addItemsFor(s).length)).toEqual([6, 6, 6])
  })

  it('labels each item once per surface', () => {
    for (const s of SURFACES) {
      const labels = ADD_ITEMS.map((i) => addItemLabel(i.id, s))
      expect(new Set(labels).size, s).toBe(labels.length)
    }
    expect(ADD_ITEMS.map((i) => addItemLabel(i.id, 'face'))).toContain('Add pattern here')
    expect(ADD_ITEMS.map((i) => addItemLabel(i.id, 'empty'))).toContain('Add pattern')
  })
})
