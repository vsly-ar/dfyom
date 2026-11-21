// The renderer's component library: screens import from here, never from Radix directly.
// Doc: docs/conventions/ui.md#components
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button/Button'
export { Checkbox, type CheckboxProps, type CheckedState } from './Checkbox/Checkbox'
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog/ConfirmDialog'
export { Dialog, DialogClose, type DialogProps } from './Dialog/Dialog'
export { EmptyState, type EmptyStateProps } from './EmptyState/EmptyState'
export { ErrorMessage, errorDetails, type ErrorMessageProps } from './ErrorMessage/ErrorMessage'
export {
  Field,
  type FieldControlProps,
  type FieldMessage,
  type FieldProps,
  type FieldSeverity,
} from './Field/Field'
export {
  FieldAdjustButton,
  FieldInput,
  type FieldAdjustButtonProps,
  type FieldInputProps,
} from './Field/FieldInput'
export { IconButton, type IconButtonProps } from './IconButton/IconButton'
export { FIELD_ICON_NAMES, FieldIcon, type FieldIconName } from './icons/field/FieldIcon'
export {
  INDICATOR_DELAY_MS,
  JobIndicator,
  JobList,
  type JobIndicatorProps,
  type JobListProps,
  type JobView,
} from './JobIndicator/JobIndicator'
export { TOOL_ICON_NAMES, ToolIcon, toolIconLabel, type ToolIconName } from './icons/tool/ToolIcon'
export {
  MachineStateBadge,
  type MachineState,
  type MachineStateBadgeProps,
} from './MachineStateBadge/MachineStateBadge'
export { Menu, type MenuEntry, type MenuProps } from './Menu/Menu'
export { ModeSwitcher, type ModeSwitcherProps } from './ModeSwitcher/ModeSwitcher'
export { useReducedMotion } from './motion'
export {
  Panel,
  PanelGroup,
  PanelHeader,
  PanelResizeHandle,
  usePanelRef,
  type PanelGroupLayout,
  type PanelGroupProps,
  type PanelHandle,
  type PanelHeaderProps,
  type PanelProps,
} from './Panel/Panel'
export { Popover, type PopoverProps } from './Popover/Popover'
export { Progress, type ProgressProps } from './Progress/Progress'
export {
  ECHO_DELAY_MS,
  ERROR_DELAY_MS,
  QuantityInput,
  STEP_SIZES,
  type QuantityInputProps,
  type ReferenceOption,
  type StepSize,
} from './QuantityInput/QuantityInput'
export type { InheritedTolerance } from './QuantityInput/reading'
export { SegmentedControl, type SegmentedControlProps } from './SegmentedControl/SegmentedControl'
export { Select, type SelectOption, type SelectProps } from './Select/Select'
export { StatusChip, type StatusChipProps, type StatusTone } from './StatusChip/StatusChip'
export { Switch, type SwitchProps } from './Switch/Switch'
export { Tabs, type TabItem, type TabsProps } from './Tabs/Tabs'
export { Term, type TermProps } from './Term/Term'
export { Toast, ToastRegion, type ToastProps } from './Toast/Toast'
export { Toolbar, ToolbarButton, ToolbarSeparator, type ToolbarProps } from './Toolbar/Toolbar'
export { Tooltip, type TooltipProps } from './Tooltip/Tooltip'
export { UndoRedo, type UndoRedoProps } from './UndoRedo/UndoRedo'
export {
  WarningItem,
  WarningList,
  type WarningListLabels,
  type WarningListProps,
  type WarningTier,
  type WarningView,
} from './WarningList/WarningList'
export {
  PortalContainer,
  ThemeScope,
  TOOLTIP_DELAY_MS,
  UiProvider,
  usePortalContainer,
} from './UiProvider/UiProvider'
