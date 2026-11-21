// User-facing strings of the quantity input (task 3.4): the catalogue for quantity and expression
// issue rules (docs/architecture/quantities.md#error-codes) and the field's own labels. Whole
// sentences with typed params, never concatenated fragments.
// Doc: docs/conventions/ui.md#quantity-and-expression-input, #errors, #internationalization
import type { QuantityKind } from '../../../core/quantity/units'

const KIND_NOUN: Readonly<Record<QuantityKind, string>> = {
  length: 'length',
  angle: 'angle',
  feedRate: 'feed rate',
  spindleSpeed: 'spindle speed',
  power: 'power',
  scalar: 'plain number',
}

const TOKEN: Readonly<Record<string, string>> = {
  digit: 'a digit',
  number: 'a number',
  reference: 'a reference',
  unit: 'a unit',
  tolerance: 'a tolerance',
  operator: 'an operator',
  end: 'nothing more',
  ' ': 'a space',
}

const article = (word: string): string => (/^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`)

/** "length", "feed rate"; unknown kinds pass through. */
export function kindNoun(kind: unknown): string {
  return typeof kind === 'string' && kind in KIND_NOUN
    ? KIND_NOUN[kind as QuantityKind]
    : String(kind)
}

function tokenList(expected: readonly string[]): string {
  const words = expected.map((t) => TOKEN[t] ?? `“${t}”`)
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`
}

/** Messages keyed by issue rule; params as the core puts them (docs/architecture/quantities.md). */
export const quantityText = {
  empty: (): string => 'Enter a value.',
  syntax: (p: { found: string | undefined; expected: readonly string[] }): string =>
    p.found === undefined
      ? `Incomplete: expected ${tokenList(p.expected)}.`
      : `Unexpected “${p.found}”: expected ${tokenList(p.expected)}.`,
  hyphenatedMixedNumber: (): string => 'Write a mixed number with a space; “-” means subtraction.',
  zeroDenominator: (): string => 'A fraction cannot have 0 as its denominator.',
  maxLength: (p: { max: number }): string => `Too long: at most ${p.max} characters.`,
  unknownUnit: (p: { actual: string; kind: QuantityKind }): string =>
    `Unknown unit “${p.actual}”. Use a ${kindNoun(p.kind)} unit such as ${unitExamples(p.kind)}.`,
  unitKind: (p: { actual: string; kind: QuantityKind }): string =>
    `“${p.actual}” is not a ${kindNoun(p.kind)} unit. Use ${unitExamples(p.kind)}.`,
  /** Deviation pair whose upper is below its lower (`order`). */
  order: (p: { upper: string; lower: string }): string =>
    `The lower deviation ${p.lower} is above the upper deviation ${p.upper}.`,
  /** `10 +1/2`, `D -1/2`: the pair is a tolerance, which the user likely did not mean. */
  deviationPair: (p: { text: string; upper: string; lower: string }): string =>
    `“${p.text}” reads as a tolerance (upper ${p.upper}, lower ${p.lower}), and the lower is above the upper. To add or subtract a fraction, put a space after the sign.`,
  nonNegative: (): string => 'A ± tolerance cannot be negative.',
  finite: (): string => 'The value is too large.',
  unknownReference: (p: { name: string }): string => `Unknown reference “${p.name}”.`,
  kindMismatch: (p: { left: unknown; right: unknown }): string =>
    `Cannot add or subtract ${article(kindNoun(p.left))} and ${article(kindNoun(p.right))}.`,
  unsupportedProduct: (p: { left: unknown; right: unknown }): string =>
    `Cannot multiply or divide ${article(kindNoun(p.left))} by ${article(kindNoun(p.right))}; multiply or divide by a plain number.`,
  resultKind: (p: { expected: unknown; actual: unknown }): string =>
    `The result is ${article(kindNoun(p.actual))}; this field needs ${article(kindNoun(p.expected))}.`,
  bareNumberUnit: (p: { kind: unknown }): string =>
    `Give the number ${article(kindNoun(p.kind))} unit, e.g. “1 mm”.`,
  divisionByZero: (): string => 'Division by zero.',
  divisorContainsZero: (): string => 'The divisor’s tolerance range includes 0.',
  cycle: (p: { cycle: readonly string[] }): string => `Circular reference: ${p.cycle.join(' → ')}.`,
  tolerancePosition: (): string => 'A tolerance can only come at the very end.',
  ambiguousDivision: (p: { hints: readonly string[] }): string =>
    `A fraction after “/” is ambiguous; write ${p.hints.map((h) => `“${h}”`).join(' or ')}.`,
  /** Greek mu (U+03BC) typed instead of the micro sign (U+00B5). */
  greekMu: (): string => 'Use the micro sign “µ” for micrometres.',

  fix: (source: string): string => `Use ${source}`,
  adjust: (label: string): string => `Adjust ${label}`,
  adjustKept: (): string =>
    'Kept the adjusted value: the project changed after it, so Escape could not revert it.',
  pick: (label: string): string => `Pick ${label} in the viewport`,
  references: (label: string): string => `References for ${label}`,
  step: (): string => 'Step',
  decrease: (): string => 'Decrease',
  increase: (): string => 'Increase',
  /** Adjust popover title hint: only keys that act in the popover (the field's ↑ ↓ do not). */
  adjustHint: (): string => 'Esc reverts',
  stepsNeedNumber: (): string => 'Steps change plain numbers, not formulas.',
  recommended: (): string => 'Recommended',
  /** Inherited general tolerance of an untoleranced value: "±0.100 mm from part". */
  inherited: (p: { tolerance: string; scope: string }): string => `${p.tolerance} from ${p.scope}`,
  /** Echo of a reference-based value: "(from pocket1.floor.z)". */
  from: (p: { references: readonly string[] }): string => `(from ${p.references.join(', ')})`,
  deviations: (p: { upper: string; lower: string }): string => `upper ${p.upper}, lower ${p.lower}`,
}

const UNIT_EXAMPLES: Readonly<Record<QuantityKind, string>> = {
  length: 'mm, in or "',
  angle: '°',
  feedRate: 'mm/min or in/min',
  spindleSpeed: 'rpm',
  power: 'W, kW or hp',
  scalar: '%',
}

function unitExamples(kind: QuantityKind): string {
  return UNIT_EXAMPLES[kind]
}
