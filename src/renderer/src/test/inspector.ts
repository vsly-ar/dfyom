// Component test helpers for the inspector chrome (DF110): select a tab, open a closed accordion
// or a More row before using the fields inside (they stay mounted but hidden).
// Doc: docs/conventions/inspector-layout.md#inspector-structure-df110
import { waitFor, within } from '@testing-library/react'
import type userEvent from '@testing-library/user-event'
import { expect } from 'vitest'

type User = ReturnType<typeof userEvent.setup>

/** Selects tab `name` ("Feeds") in `scope` unless it is selected. */
export async function openInspectorTab(
  user: User,
  scope: HTMLElement,
  name: string,
): Promise<void> {
  const tab = within(scope).getByRole('tab', { name: new RegExp(`^${name}\\b`) })
  if (tab.getAttribute('aria-selected') !== 'true') await user.click(tab)
  await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'))
}

/** Opens accordion `title` ("Tool setup") in `scope` unless it is open; returns its region. */
export async function openInspectorGroup(
  user: User,
  scope: HTMLElement,
  title: string,
): Promise<HTMLElement> {
  const region = within(scope).getByRole('region', { name: title })
  const toggle = region.querySelector<HTMLElement>(
    ':scope > div > h3 > button[aria-expanded], :scope > div > h4 > button[aria-expanded]',
  )
  if (toggle?.getAttribute('aria-expanded') === 'false') await user.click(toggle)
  return region
}

/** Opens the More row in `scope` whose button names `field` ("More (…, Overshoot)"). */
export async function openInspectorMore(
  user: User,
  scope: HTMLElement,
  field: string,
): Promise<void> {
  const button = within(scope).getByRole('button', { name: new RegExp(`^More \\(.*${field}`) })
  if (button.getAttribute('aria-expanded') === 'false') await user.click(button)
}
