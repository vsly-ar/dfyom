// Setup for the `ui` test project (jsdom): jest-dom matchers, cleanup, and the browser APIs
// Radix needs that jsdom lacks. Doc: docs/conventions/ui.md#testing
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setReducedMotion } from './media'

afterEach(() => {
  cleanup()
  setReducedMotion(false)
  vi.restoreAllMocks()
})

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

const proto = Element.prototype as Element & Record<string, unknown>
proto['scrollIntoView'] ??= function scrollIntoView(): void {}
proto['hasPointerCapture'] ??= function hasPointerCapture(): boolean {
  return false
}
proto['setPointerCapture'] ??= function setPointerCapture(): void {}
proto['releasePointerCapture'] ??= function releasePointerCapture(): void {}
