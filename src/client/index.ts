/**
 * Task-board browser plugin: one Host-backed controller, one shared root store,
 * and two contributions forming the sidebar launcher and frame overlay.
 * @module @deepseek-ai/dsh-client-ui-task-board/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TaskBoardController, type TaskBoardRemote } from './controller.ts'
import { TaskBoardLauncher } from './TaskBoardLauncher.tsx'
import { TaskBoardOverlay } from './TaskBoardOverlay.tsx'
import { createTaskBoardStore } from './store.ts'
import { en, NS, zh } from './locales.ts'
import type { TaskBoardInjected } from './slots.ts'
import { loadRoundHistory, type TaskBoardHistoryApi } from './history.ts'
import { mountTaskBoardRemote } from './remote.ts'
import { SnapshotPoller } from './snapshot-poller.ts'

const SNAPSHOT_POLL_INTERVAL_MS = 1_000

export type {
  TaskBoardClientResult,
  TaskBoardClientStatus,
  TaskBoardClientView,
  TaskBoardRemote,
} from './controller.ts'
export type {
  TaskBoardDisplayKey,
  TaskBoardDisplayOptions,
  TaskBoardUiState,
  TaskBoardViewMode,
} from './store.ts'
export type {
  TaskBoardAgentPresetOption,
  TaskBoardInjected,
  TaskBoardLauncherProps,
  TaskBoardOverlayProps,
} from './slots.ts'
export { TaskBoardController } from './controller.ts'
export { taskBoardErrorMessage } from './controller.ts'
export { TaskBoardLauncher } from './TaskBoardLauncher.tsx'
export { TaskBoardOverlay } from './TaskBoardOverlay.tsx'
export { createTaskBoardStore } from './store.ts'
export { loadRoundHistory } from './history.ts'
export type {
  TaskBoardHistoryAssistantRow,
  TaskBoardHistoryEventRow,
  TaskBoardHistoryOptions,
  TaskBoardHistoryRow,
  TaskBoardRoundHistory,
} from './history.ts'

/** Services required by the browser plugin. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'workspaces', 'connection']

/**
 * Register the task-board synchronization layer and both UI entries.
 * @param ctx - Client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const remote = ctx.remote as ClientRemote
  const unmountRemote = await mountTaskBoardRemote(remote)
  ctx.effect(() => unmountRemote, 'ui-task-board: remote contribution')

  const taskBoard = ctx.get('remote.taskBoard') as TaskBoardRemote | undefined
  if (taskBoard === undefined) {
    throw new Error('task-board Remote contribution mounted without remote.taskBoard')
  }
  const controller = new TaskBoardController(taskBoard)
  const poller = new SnapshotPoller(async () => {
    await controller.refresh()
  }, { intervalMs: SNAPSHOT_POLL_INTERVAL_MS })
  const store = createTaskBoardStore()

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-task-board: dictionaries')
  ctx.effect(() => {
    const disposeReset = ctx.on('connection/reset', () => {
      void controller.connectionReset()
      void poller.refreshNow()
    })
    void poller.start()
    return () => {
      disposeReset()
      poller.dispose()
      controller.dispose()
    }
  }, 'ui-task-board: synchronization')

  const injected = (): TaskBoardInjected => ({
    hooks: { board: controller },
    refresh: () => controller.refresh(),
    loadAgentPresets: async () => {
      const response = await remote.agentPresets.list()
      if (!response.ok) throw new Error(response.error.message)
      return response.value.presets.flatMap(preset => preset.broken === undefined
        ? [{
          id: preset.id,
          isDefault: preset.isDefault,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
        }]
        : [])
    },
    // NOTE (0.1.7-rc.2 port): ctx.workspaces.pickDirectory() no longer exists.
    // Directory selection moved to the directory-picker UI plugins; this face
    // now resolves a Workspace path from the create flow instead. Kept as a
    // null-returning stub so the injected shape stays stable — the author's
    // original picker wiring was removed with the old IWorkspaces contract.
    pickDirectory: () => Promise.resolve(null),
    uploadAttachment: request => controller.uploadAttachment(request),
    create: request => controller.create(request),
    edit: (taskId, patch) => controller.edit(taskId, patch),
    reorder: (taskId, beforeTaskId) => controller.reorder(taskId, beforeTaskId),
    start: taskId => controller.start(taskId),
    followup: (taskId, text) => controller.followup(taskId, text),
    approve: taskId => controller.approve(taskId),
    reject: (taskId, feedback) => controller.reject(taskId, feedback),
    retry: (taskId, allowFreshSession) => controller.retry(taskId, allowFreshSession),
    stop: taskId => controller.stop(taskId),
    reopen: taskId => controller.reopen(taskId),
    delete: taskId => controller.delete(taskId),
    loadRoundHistory: (round, signal) => loadRoundHistory(remote as unknown as TaskBoardHistoryApi, round, signal),
    // NOTE (0.1.7-rc.2 port): ctx.sessions.open() no longer exists; the new
    // lifecycle is retain(target, { source }) + reference.ready. We retain and
    // let the caller surface drive the actual view open via the session list.
    openSession: (sessionId) => { ctx.sessions.retain(sessionId, { source: 'task-board' as never }) },
  })

  ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'task-board',
    order: -20,
    locale: NS,
    store,
    inject: injected,
  }, TaskBoardLauncher)

  ctx.slots.register({
    name: 'shell.overlay',
    id: 'task-board',
    order: 0,
    locale: NS,
    store,
    inject: injected,
  }, TaskBoardOverlay)
}
