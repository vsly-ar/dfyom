// Component test helpers: render inside the app's UI providers, and an axe-core check.
// Doc: docs/conventions/ui.md#testing
import { render, screen, waitFor, within, type RenderResult } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import axe from 'axe-core'
import type { ReactElement } from 'react'
import { expect } from 'vitest'
import { UiProvider } from '../ui/UiProvider/UiProvider'

/** Renders `ui` inside `UiProvider` (tooltip timing, portals) with a user-event instance. */
export function renderUi(
  ui: ReactElement,
): RenderResult & { user: ReturnType<typeof userEvent.setup> } {
  const user = userEvent.setup()
  return { user, ...render(<UiProvider>{ui}</UiProvider>) }
}

/**
 * Asserts axe-core finds no violations. Contrast is excluded: jsdom does not compute styles;
 * colour contrast is checked on the tokens (tokens.test.ts).
 */
export async function expectNoAxeViolations(root: Element = document.body): Promise<void> {
  const result = await axe.run(root, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  })
  const summary = result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.html).join(', ')})`,
  )
  expect(summary).toEqual([])
}

/**
 * Finds a toast's action button once it can take a click. Radix renders the toast into the
 * viewport first and lifts the viewport's `pointer-events: none` one render later (its toast
 * count is updated from an effect), so a click right after the toast text appears can hit the
 * blocked viewport under load.
 */
export async function findToastAction(name: string): Promise<HTMLElement> {
  const region = await screen.findByRole('region', { name: /^Notifications/ })
  const button = await within(region).findByRole('button', { name })
  await waitFor(() => {
    for (let e: Element | null = button; e !== null; e = e.parentElement)
      expect(getComputedStyle(e).pointerEvents).not.toBe('none')
  })
  return button
}
