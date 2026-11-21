// Project files in the window (task 3.6): New / Open / Save / Save as, the recovery prompt and a
// foreign lock ("Retry in 2 min"). The window calls the same app-scope commands as agents
// (`project.create`, `project.open`, `project.save`, `project.recovery.*`); only the native file
// dialogs are window plumbing. Opening, creating and restoring go through `window.openProject`,
// which runs the command in the window that should show the project: this one when it has none,
// the one already showing the file, else a new window (nothing here is replaced or closed). Used
// by every mode. Doc: docs/conventions/ui.md#project-files,
// docs/architecture/persistence.md#open, #crash-recovery, #lock
import { createStore, type StoreApi } from 'zustand/vanilla'
import type { UnitSystem } from '../../../../core/project/document'
import type { AppErrorData } from '../../../../shared/errors/app-error'
import type { CallReply, PreloadApi } from '../../../../shared/preload-api'
import type { ReplicaState } from '../../state/replica'

/** A lock of another computer's instance can be taken over after this long (persistence.md#lock). */
export const LOCK_RETRY_MS = 2 * 60 * 1000

export type FilesDialog =
  | { readonly kind: 'new' }
  | { readonly kind: 'recovery'; readonly key: string; readonly file: string | null }
  | {
      readonly kind: 'locked'
      readonly file: string
      readonly error: AppErrorData
      /** Clock time of the scheduled retry, while one waits. */
      readonly retryAt?: number
    }
  | {
      readonly kind: 'error'
      readonly title: 'open' | 'save' | 'create'
      readonly error: AppErrorData
    }

export interface RecoverableView {
  readonly key: string
  readonly filePath: string | null
}

export interface FilesState {
  readonly dialog: FilesDialog | null
  readonly busy: boolean
  /** Projects with unsaved changes of an earlier session (start screen). */
  readonly recoverable: readonly RecoverableView[]
  closeDialog(): void
  /** "New project…": the new-project dialog. */
  newProject(): void
  create(name: string, unitSystem: UnitSystem): Promise<void>
  /** "Open project…": the native dialog, then `openFile`. */
  open(): Promise<void>
  openFile(file: string): Promise<void>
  /** Save; an untitled project goes to Save as. True when saved. */
  save(): Promise<boolean>
  saveAs(): Promise<boolean>
  recover(key: string, action: 'restore' | 'discard'): Promise<void>
  /** Retry the locked open now, or schedule it after `LOCK_RETRY_MS`. */
  retryLocked(later: boolean): void
  refreshRecoverable(): Promise<void>
}

export type ProjectFiles = StoreApi<FilesState>

interface Deps {
  readonly bridge: Pick<PreloadApi, 'call' | 'files'> & {
    readonly window: Pick<PreloadApi['window'], 'openProject'>
  }
  readonly replica: { getState(): ReplicaState }
  readonly now?: () => number
}

function frameData(error: AppErrorData, field: string): unknown {
  return error.frames.map((f) => f.data?.[field]).find((v) => v !== undefined)
}

export function createProjectFiles({ bridge, replica, now = Date.now }: Deps): ProjectFiles {
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const store = createStore<FilesState>()((set, get) => {
    const currentKey = (): string | undefined => {
      const r = replica.getState()
      return r.status === 'open' ? r.key : undefined
    }

    /** One opening call (in the window main picks); maps recovery and lock answers to their dialogs. */
    const opening = async (
      kind: 'open' | 'create' | 'recover',
      file: string | null,
      call: () => Promise<CallReply>,
    ) => {
      set({ busy: true })
      const r = await call()
      set({ busy: false })
      if (r.ok) {
        set({ dialog: null })
        void get().refreshRecoverable()
        return
      }
      const e = r.error
      if (e.code === 'persist.recovery') {
        const key = frameData(e, 'key')
        if (typeof key === 'string') {
          set({ dialog: { kind: 'recovery', key, file } })
          return
        }
      }
      if (e.code === 'persist.locked' && file !== null) {
        set({ dialog: { kind: 'locked', file, error: e } })
        return
      }
      set({ dialog: { kind: 'error', title: kind === 'recover' ? 'open' : kind, error: e } })
    }

    const saveTo = async (target: string | undefined): Promise<boolean> => {
      set({ busy: true })
      // the OS dialog already asked before replacing an existing file
      const r = await bridge.call(
        'project.save',
        target === undefined ? {} : { target, confirm: true },
      )
      set({ busy: false })
      if (!r.ok) set({ dialog: { kind: 'error', title: 'save', error: r.error } })
      return r.ok
    }

    return {
      dialog: null,
      busy: false,
      recoverable: [],
      closeDialog() {
        clearTimeout(retryTimer)
        set({ dialog: null })
      },
      newProject() {
        set({ dialog: { kind: 'new' } })
      },
      create(name, unitSystem) {
        return opening('create', null, () =>
          bridge.window.openProject('project.create', { name, unitSystem }),
        )
      },
      async open() {
        const file = await bridge.files.chooseOpen()
        if (file === null) return
        await get().openFile(file)
      },
      openFile(file) {
        return opening('open', file, () => bridge.window.openProject('project.open', { file }))
      },
      async save() {
        const r = replica.getState()
        if (r.status !== 'open') return false
        if (r.file === null) return get().saveAs()
        return saveTo(undefined)
      },
      async saveAs() {
        const r = replica.getState()
        if (r.status !== 'open') return false
        const target = await bridge.files.chooseSave(r.doc.name)
        if (target === null) return false
        return saveTo(target)
      },
      recover(key, action) {
        const d = get().dialog
        const file = d?.kind === 'recovery' ? d.file : null
        return opening('recover', file, () =>
          bridge.window.openProject('project.recovery.resolve', {
            key,
            action,
            ...(action === 'discard' ? { confirm: true } : {}),
          }),
        )
      },
      retryLocked(later) {
        const d = get().dialog
        if (d?.kind !== 'locked') return
        clearTimeout(retryTimer)
        if (!later) {
          void get().openFile(d.file)
          return
        }
        set({ dialog: { ...d, retryAt: now() + LOCK_RETRY_MS } })
        retryTimer = setTimeout(() => {
          const still = get().dialog
          if (still?.kind === 'locked' && still.file === d.file) void get().openFile(d.file)
        }, LOCK_RETRY_MS)
      },
      async refreshRecoverable() {
        const r = await bridge.call('project.recovery.list', {})
        if (!r.ok) return
        const projects = (r.value as { projects: RecoverableView[] }).projects
        const open = currentKey()
        set({
          recoverable: projects
            .filter((p) => p.key !== open)
            .map((p) => ({ key: p.key, filePath: p.filePath })),
        })
      },
    }
  })
  return store
}
