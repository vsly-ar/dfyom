// The vendored CavalierContours module matches its recorded SHA-256 (plans/v0.3.md Q26): CI checks
// the checksum instead of rebuilding, so it needs no Rust toolchain. Doc: docs/architecture/shapes.md#2d-port
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  checksumLine,
  recordedSha256,
  SHA256_PATH,
  sha256,
  WASM_PATH,
} from './build-cavalier-wasm.mjs'

describe('vendored cavalier_contours.wasm', () => {
  it('matches its recorded SHA-256', () => {
    const bytes = readFileSync(WASM_PATH)
    expect(sha256(bytes)).toBe(recordedSha256(readFileSync(SHA256_PATH, 'utf8')))
  })

  it('records the checksum in the shasum format', () => {
    expect(checksumLine(new Uint8Array([1, 2, 3]))).toBe(
      '039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81  cavalier_contours.wasm\n',
    )
    expect(recordedSha256('abc  cavalier_contours.wasm\n')).toBe('abc')
  })
})
