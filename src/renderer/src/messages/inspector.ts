// Texts of the shared inspector chrome: groups, accordions, More rows and tab badges (DF110).
// Doc: docs/conventions/inspector-layout.md#inspector-structure-df110
export const inspectorMessages = {
  /** The More row's button: the rare fields it holds, by name. */
  more: (fields: readonly string[]) => (fields.length > 0 ? `More (${fields.join(', ')})` : 'More'),
  /** A closed accordion's or a tab's problem, for screen readers (the icon / dot is visual). */
  severity: { error: 'has errors', warning: 'has warnings' },
} as const
