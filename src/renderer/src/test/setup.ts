// Setup for the `ui` test project (jsdom): jest-dom matchers, cleanup, and the browser APIs
// Radix needs that jsdom lacks. Doc: docs/conventions/ui.md#testing
import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { setReducedMotion } from './media'

// `findBy*` / `waitFor` wait up to 5 s instead of 1 s: under heavy load a bridge round trip and
// re-render can take over a second. Only the time to report a failure grows; what is awaited does
// not change (docs/conventions/testing.md#commands, Timeouts).
configure({ asyncUtilTimeout: 5000 })

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
