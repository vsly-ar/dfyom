// Term: a glossary term in running text or a label, dotted underline, its one-line definition as a
// tooltip (on hover and on keyboard focus). Definitions come from the glossary, with real values
// where possible ("Stepdown: 1.5 mm per pass for this pocket"). "Learn more" (the wiki panel) comes
// later. Doc: docs/conventions/ui.md#copy-and-terminology
import type { ReactNode } from 'react'
import { Tooltip } from '../Tooltip/Tooltip'
import styles from './Term.module.css'

export interface TermProps {
  /** The term as shown, exactly the glossary term ("Stepdown"). */
  children: ReactNode
  /** One-line definition. */
  definition: ReactNode
  side?: 'top' | 'right' | 'bottom' | 'left'
  /** Layout only; appended to the wrapper's class. */
  className?: string | undefined
}

export function Term({
  children,
  definition,
  side = 'top',
  className,
}: TermProps): React.JSX.Element {
  return (
    <Tooltip content={definition} side={side}>
      {/* focusable so keyboard users reach the definition; Radix wires aria-describedby */}
      <span tabIndex={0} className={[styles['term'], className].filter(Boolean).join(' ')}>
        {children}
      </span>
    </Tooltip>
  )
}
