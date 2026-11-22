/**
 * SVG import core (task I1): `importSvg(text, options)` → shapes and the import report.
 * Doc: docs/architecture/shapes.md#svg-import
 */
export {
  importSvg,
  SVG_LIMITS,
  type SvgImport,
  type SvgImportOptions,
  type SvgImportReport,
  type SvgImportWarning,
  type SvgLimits,
  type SvgShape,
  type SvgShapeItem,
  type SvgSplit,
} from './import'
export type { SvgUnit } from './units'
