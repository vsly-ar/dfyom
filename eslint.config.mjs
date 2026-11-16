// Lint setup and layer import boundaries: ADR 0015 (docs/decisions/0015-eslint-with-typescript6-api.md),
// layer rules: docs/architecture/overview.md#source-layout.
import { builtinModules } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const ROOT = import.meta.dirname

/**
 * `layers/no-import-from`: forbid relative imports that resolve into the given
 * repo directories. Resolves the path (unlike pattern-based `no-restricted-imports`),
 * so `src/renderer/src/main.tsx` is not mistaken for `src/main/`.
 */
const layers = {
  rules: {
    'no-import-from': {
      meta: {
        type: 'problem',
        schema: [{ type: 'array', items: { type: 'string' } }],
        messages: {
          forbidden: "'{{source}}' reaches into {{dir}}/, which this layer must not import.",
        },
      },
      create(context) {
        const forbidden = context.options[0] ?? []
        const check = (node) => {
          const source = node?.value
          if (typeof source !== 'string' || !source.startsWith('.')) return
          const target = relative(ROOT, resolve(dirname(context.filename), source)).replaceAll(
            '\\',
            '/',
          )
          const dir = forbidden.find((d) => target === d || target.startsWith(`${d}/`))
          if (dir) context.report({ node, messageId: 'forbidden', data: { source, dir } })
        }
        return {
          ImportDeclaration: (n) => check(n.source),
          ExportNamedDeclaration: (n) => check(n.source),
          ExportAllDeclaration: (n) => check(n.source),
          ImportExpression: (n) => check(n.source),
        }
      },
    },
  },
}

/** Electron and Node-only modules; `src/core` and `src/shared` must run anywhere. */
const nodeOnlyImports = {
  paths: ['electron', ...builtinModules.filter((m) => !m.startsWith('_'))].map((name) => ({
    name,
    message: 'Environment-specific module: keep src/core and src/shared environment-neutral.',
  })),
  patterns: [
    {
      group: ['node:*'],
      message: 'Node built-in: keep src/core and src/shared environment-neutral.',
    },
  ],
}

export default defineConfig(
  { ignores: ['out/', 'dist/', 'release/', 'coverage/', 'graft/', '.claude/'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts}'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: ROOT } },
    rules: {
      // Type-aware rules kept to a few high-value ones (see ADR 0015).
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/core/**', 'src/shared/**'],
    plugins: { layers },
    rules: {
      'no-restricted-imports': ['error', nodeOnlyImports],
      'layers/no-import-from': ['error', ['src/main', 'src/preload', 'src/renderer']],
    },
  },
  {
    files: ['src/renderer/**'],
    plugins: { layers },
    rules: { 'layers/no-import-from': ['error', ['src/main', 'src/preload']] },
  },
  {
    files: ['src/renderer/**/*.tsx'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['scripts/**', '*.config.{ts,mts,mjs}', 'src/main/**', 'src/preload/**'],
    languageOptions: { globals: globals.node },
  },
  prettier,
)
