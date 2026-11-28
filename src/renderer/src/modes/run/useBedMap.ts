// The machine's bed map (v0.5 RV11) as Run uses it: the saved record (app settings `bedMaps`, per
// library machine), whether it may be used now (homed, the same homing and work area, no failed
// repeatability test since; old after the age setting), the stickout of the tool the guard assumes,
// the floor sent to a real connection (`run.machine.floor`, mounted once while in Run mode), and
// the map as `run.job.check`/`start`'s `surfaceMap` for "Compensate with the bed map".
// Doc: docs/modes/run-surface.md#the-bed-map-rv11
import { useEffect, useMemo } from 'react'
import {
  bedFollowMap,
  bedMapState,
  floorSetting,
  spoilboardFloorZ,
  type BedMapState,
} from '../../../../core/run/bed-map'
import type { ProjectDoc } from '../../../../core/project/document'
import type { BedMapRecord } from '../../../../shared/settings'
import { useSettings, useShell } from '../../shell/ShellContext'
import { useLibraryItems } from '../plan/usePlan'
import { useMachineJog } from './JogPad'
import { isConnected } from './machine-state'
import { machineBed } from './plan-info'
import { NO_PLAN, useRun } from './run-store'
import { useRunWorkholding } from './useRunWorkholding'

export interface BedMapView {
  /** The library machine id (the record's key); undefined: no library machine. */
  readonly key?: string
  readonly record?: BedMapRecord
  /** Absent without a record. */
  readonly state?: BedMapState
  /** The stickout of the tool the guard assumes (mm), when a plan's setup has one. */
  readonly stickout?: number
}

/** The machine's bed map and whether it may be used now. */
export function useBedMap(doc: ProjectDoc | undefined): BedMapView {
  const key = useMachineJog(doc).key
  const status = useRun((s) => s.status)
  const record = useSettings((s) => (key === undefined ? undefined : s.settings.bedMaps[key]))
  const repeat = useSettings((s) =>
    key === undefined ? undefined : s.settings.homingRepeatability[key],
  )
  const maxAgeDays = useSettings((s) => s.settings.bedMapMaxAge)
  const stickout = useRunWorkholding()?.tool?.stickout
  const env = status.envelope
  const state = useMemo(
    () =>
      record === undefined || record === null
        ? undefined
        : bedMapState(record, {
            homed: status.homed && isConnected(status),
            ...(env === undefined
              ? {}
              : {
                  envelope: {
                    travel: env.travel,
                    pullOff: env.pullOff,
                    homingMask: env.homingMask,
                    ...(env.workArea === undefined ? {} : { workArea: env.workArea }),
                  },
                }),
            ...(repeat === undefined
              ? {}
              : { repeatability: { date: repeat.date, pass: repeat.pass } }),
            now: Date.now(),
            maxAgeDays,
          }),
    // the age is read when the record or the status changes, not on a timer
    [record, status, env, repeat, maxAgeDays],
  )
  return {
    ...(key === undefined ? {} : { key }),
    ...(record === undefined || record === null ? {} : { record }),
    ...(state === undefined ? {} : { state }),
    ...(stickout === undefined ? {} : { stickout }),
  }
}

/** The bed map as `run.job.check`/`start`'s `surfaceMap`, in the live G54's work frame. */
export function bedFollowArg(
  record: BedMapRecord,
  workZero: readonly [number, number, number],
  maxRange: number,
): object {
  const m = bedFollowMap(record, [workZero[0], workZero[1]])
  return {
    origin: m.origin,
    spacing: m.spacing,
    cols: m.cols,
    rows: m.rows,
    z: m.z,
    workZero: m.workZero,
    maxRange,
  }
}

/**
 * Sends a real connection its floor whenever it changes (mounted once while in Run mode): the
 * usable bed map for the guard's tool, and the spoilboard estimate when the machine has its nose to
 * table distance and the tool's stickout is known. The virtual machine gets none: its stock and bed
 * are laid wherever the operator zeroed (docs/modes/run-surface.md#uses).
 */
export function useProbeFloorSync(doc: ProjectDoc | undefined): void {
  const { bridge } = useShell()
  const bed = useBedMap(doc)
  const status = useRun((s) => s.status)
  const planId = useRun((s) => s.planId)
  const machineId = useRun((s) => s.machineId)
  const machines = useLibraryItems('machine')
  const plan = planId === undefined || planId === NO_PLAN ? undefined : doc?.plans[planId]
  const { noseToTable, spoilboard } = machineBed(plan, machines, machineId)
  const serial = isConnected(status) && status.connection.target === 'serial'
  const pullOff = status.envelope?.pullOff
  const plane =
    noseToTable === undefined || bed.stickout === undefined || pullOff === undefined
      ? undefined
      : spoilboardFloorZ(noseToTable, spoilboard ?? 0, pullOff, bed.stickout)
  const usable =
    bed.state !== undefined && bed.state.unusable === undefined ? bed.record : undefined
  const setting =
    serial && status.homed
      ? floorSetting(usable, {
          ...(bed.stickout === undefined ? {} : { stickout: bed.stickout }),
          ...(plane === undefined ? {} : { plane }),
        })
      : undefined
  const json = JSON.stringify(setting ?? null)
  useEffect(() => {
    if (!serial) return
    const floor = JSON.parse(json) as object | null
    void bridge.call('run.machine.floor', floor === null ? {} : { floor })
  }, [bridge, serial, json])
}
