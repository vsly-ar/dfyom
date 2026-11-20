import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { readTokens, useToken, useTokens } from './useTokens'

const NAMES = ['--vp-part', '--vp-edge'] as const

afterEach(() => {
  delete document.documentElement.dataset['theme']
  document.body.innerHTML = ''
})

function element(style: string): HTMLDivElement {
  const el = document.createElement('div')
  el.setAttribute('style', style)
  document.body.append(el)
  return el
}

describe('useTokens', () => {
  it('reads custom properties on the element, trimmed, empty when missing', () => {
    const el = element('--vp-part: #f9faff ;')
    expect(readTokens(el, NAMES)).toEqual({ '--vp-part': '#f9faff', '--vp-edge': '' })
  })

  it('re-reads when the theme changes', async () => {
    const el = element('--vp-part: #f9faff; --vp-edge: #39423f')
    const ref = { current: el }
    const { result } = renderHook(() => useTokens(ref, NAMES))
    expect(result.current['--vp-part']).toBe('#f9faff')
    el.setAttribute('style', '--vp-part: #2b3232; --vp-edge: #d5dbe3')
    await act(async () => {
      document.documentElement.dataset['theme'] = 'dark'
      await Promise.resolve() // MutationObserver callbacks are microtasks
    })
    expect(result.current).toEqual({ '--vp-part': '#2b3232', '--vp-edge': '#d5dbe3' })
  })

  it('useToken reads one token', () => {
    const ref = { current: element('--vp-edge: #39423f') }
    const { result } = renderHook(() => useToken(ref, '--vp-edge'))
    expect(result.current).toBe('#39423f')
  })
})
