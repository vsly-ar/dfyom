// Component test helpers: render inside the app's UI providers, and an axe-core check.
// Doc: docs/conventions/ui.md#testing
import { render, type RenderResult } from '@testing-library/react'
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
