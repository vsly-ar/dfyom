// The renderer's component library: screens import from here, never from Radix directly.
// Doc: docs/conventions/ui.md#components
export {
  ANCHOR_GRID,
  AnchorPicker,
  type AnchorAxisPoint,
  type AnchorPickerProps,
  type AnchorValue,
} from './AnchorPicker/AnchorPicker'
export {
  ApplyButton,
  LIVE_DELAY_MS,
  type ApplyButtonProps,
  type ApplyButtonState,
} from './ApplyButton/ApplyButton'
export { ApplyScope, MODAL_ATTR, modalDialogOpen, useApplyOnEnter } from './ApplyButton/ApplyScope'
export { Button, type ButtonProps, type ButtonSize, type ButtonVariant } from './Button/Button'
export { Checkbox, type CheckboxProps, type CheckedState } from './Checkbox/Checkbox'
export { ConfirmDialog, type ConfirmDialogProps } from './ConfirmDialog/ConfirmDialog'
export { Dialog, DialogClose, type DialogProps } from './Dialog/Dialog'
export { EmptyState, type EmptyStateProps } from './EmptyState/EmptyState'
export { ErrorMessage, errorDetails, type ErrorMessageProps } from './ErrorMessage/ErrorMessage'
export {
  Field,
  ReadOnlyReason,
  type FieldControlProps,
  type FieldMessage,
  type FieldProps,
  type FieldSeverity,
} from './Field/Field'
export { FieldInput, type FieldInputProps } from './Field/FieldInput'
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
export {
  ICON_NAMES,
  ICON_SET,
  Icon,
  iconLabel,
  type IconGroup,
  type IconName,
  type IconProps,
  type IconRotation,
  type IconSize,
} from './icons/Icon'
export {
  MachineStateBadge,
  type MachineState,
  type MachineStateBadgeProps,
} from './MachineStateBadge/MachineStateBadge'
export {
  ContextMenu,
  isContextMenuKey,
  Menu,
  openContextMenu,
  type ContextMenuProps,
  type MenuEntry,
  type MenuGroup,
  type MenuItem,
  type MenuProps,
  type MenuSub,
} from './Menu/Menu'
export { ModeSwitcher, type ModeSwitcherProps } from './ModeSwitcher/ModeSwitcher'
export { motionMs, useReducedMotion } from './motion'
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
  newGestureId,
  type QuantityCommitProps,
  type QuantityInputProps,
  type ReferenceOption,
} from './QuantityInput/QuantityInput'
export {
  STEP_LADDERS,
  stepsFor,
  stockStepScale,
  type StepKind,
  type StepScale,
} from './QuantityInput/steps'
export { StepMemoryProvider, StepScaleProvider, type StepMemory } from './QuantityInput/StepContext'
export type { InheritedTolerance } from './QuantityInput/reading'
export {
  DRAG_THRESHOLD_PX,
  DragGrip,
  ReorderStatus,
  useReorder,
  type Reorder,
  type ReorderItemProps,
  type ReorderOptions,
} from './Reorder/Reorder'
export { dropGap, dropIndex, movedFrom, moveItem } from './Reorder/drop'
export { SegmentedControl, type SegmentedControlProps } from './SegmentedControl/SegmentedControl'
export { Slider, type SliderProps } from './Slider/Slider'
export { groupOptions, Select, type SelectOption, type SelectProps } from './Select/Select'
export { StatusChip, type StatusChipProps, type StatusTone } from './StatusChip/StatusChip'
export { StopControl, type StopControlProps } from './StopControl/StopControl'
export { Switch, type SwitchProps } from './Switch/Switch'
export { Tabs, type TabItem, type TabsProps } from './Tabs/Tabs'
export {
  InspectorGroup,
  type GroupSeverity,
  type InspectorGroupProps,
  type InspectorMoreProps,
} from './InspectorGroup/InspectorGroup'
export {
  InspectorMemoryProvider,
  inspectorMemory,
  resetInspectorMemory,
  revealInInspector,
  SESSION_INSPECTOR_MEMORY,
  useInspectorMemory,
  useRememberedTab,
  type InspectorMemory,
} from './InspectorGroup/memory'
export { Term, type TermProps } from './Term/Term'
export { Toast, ToastAnchor, ToastRegion, TOAST_DURATION_MS, type ToastProps } from './Toast/Toast'
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
