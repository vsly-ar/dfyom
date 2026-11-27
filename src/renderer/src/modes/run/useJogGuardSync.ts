// DF133 RW3: the run store's jog guard setup in step with the run's setup, its items and the tool in
// the spindle (Q189); mounted once while in Run mode, with the jog hotkeys.
// Doc: docs/modes/run-workholding.md#implementation-rw3
import { useEffect } from 'react'
import { useRunStore } from './run-store'
import { guardEnvelope } from './run-workholding'
import { useRunWorkholding } from './useRunWorkholding'

/**
 * Keeps the run store's guard setup in step with the run's setup and the tool in the spindle
 * (mounted once while in Run mode, with the jog hotkeys).
 */
export function useJogGuardSync(): void {
  const store = useRunStore()
  const wh = useRunWorkholding()
  useEffect(() => {
    const tool = wh?.tool
    if (wh === undefined || tool === undefined || wh.holding.prisms.length === 0) {
      store.getState().setGuardSetup(undefined)
      return
    }
    const { stock } = wh.holding
    store.getState().setGuardSetup({
      key: `${wh.plan.dto.id}:${wh.setup.id}`,
      setup: {
        envelope: guardEnvelope(tool),
        prisms: wh.holding.prisms,
        margin: wh.holding.margin,
        stock: { length: stock.length, width: stock.width },
      },
      zero: wh.zero,
      names: Object.fromEntries(wh.holding.items.map((i) => [i.id, i.name])),
    })
  }, [store, wh])
}
