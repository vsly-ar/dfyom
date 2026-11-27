// The icon of each tool type (B22, decision D33): a side view told apart by its amber tip, always
// shown next to the tool's name. Doc: docs/conventions/ui.md#icons
import type { ToolType } from '../../../core/library/tool.dto'
import type { IconName } from '../ui'

export const TOOL_TYPE_ICON = {
  flatEndMill: 'flat-end-mill',
  bullNoseEndMill: 'bull-nose-end-mill',
  ballEndMill: 'ball-end-mill',
  drill: 'drill',
  chamferMill: 'chamfer-mill',
  // its own icon comes with the Library form (tapered-ball-nose.md § Library window, T3)
  taperedBallEndMill: 'ball-end-mill',
} as const satisfies Record<ToolType, IconName>
