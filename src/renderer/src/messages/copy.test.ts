// Copy rules that hold for every user-facing string: an ellipsis is the one character "…"
// (U+2026), never three dots. Scans the string and template literals of the message catalogue and
// the native menu. Doc: docs/conventions/ui.md#copy-and-terminology
// Runs in the node test project and is typechecked by tsconfig.node.json (it reads files).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const MESSAGES = dirname(fileURLToPath(import.meta.url))
const FILES = [
  ...readdirSync(MESSAGES)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(MESSAGES, f)),
  join(MESSAGES, '../../../main/menu.ts'),
  join(MESSAGES, '../../../main/quit.ts'),
]

/** Text of every string and template literal piece in a file. */
function literals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
  const out: string[] = []
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    )
      out.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return out
}

describe('copy', () => {
  it.each(FILES.map((f) => [f.split('/src/')[1]!, f]))(
    '%s writes an ellipsis as “…”, never "..."',
    (_, file) => {
      expect(literals(file).filter((s) => s.includes('...'))).toEqual([])
    },
  )
})
