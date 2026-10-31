/**
 * The tree's asynchronous half: listing directories into the store.
 *
 * The component never awaits anything. It calls `start` / `refresh` / `toggle`, and
 * this face performs the listing and writes the outcome through the store's own
 * actions — the Slot-standard `inject` shape, so the session id is resolved by
 * the framework and the write set stays the store's.
 *
 * The listing itself is bound here to the Client Remote face: the tree keys
 * every level by absolute path and hands the endpoint that same absolute path;
 * the endpoint answers with the directory's workspace-relative path as well,
 * which the tree has no use for and drops.
 *
 * One level has one listing in force: asking for a level again — the reload
 * gesture, a directory reopened after a reset — retires the listing still in
 * flight for it, whose settlement then writes nothing. Cleanup rides the owner's
 * `signal`: a request is not made for a record that already ended, and when the
 * record goes away the bucket and the tab's listing bookkeeping are forgotten,
 * so no later settlement writes to it.
 */
import type { ClientRemote, RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { DirLevel, createFilesStore } from './store.ts'
import type { WorkspaceFileSearchRequest, WorkspaceFileSearchResult, WorkspaceFileWatchFrame } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { DirectoryNode } from './directory-node.ts'

/**
 * Observe one directory without recursively watching its descendants.
 * @param sessionId - Session owning the directory tree.
 * @param path - absolute directory path.
 * @param signal - node lifetime.
 * @returns readiness and invalidation notifications.
 */
export type WatchWorkspaceDirectory = (sessionId: SessionId, path: string, signal: AbortSignal) => AsyncIterable<'ready' | 'change'>

/**
 * Bind directory observation to the Remote stream supervisor.
 * @param remote - Client Remote with workspace file streams.
 * @returns a watcher that awaits stream disposal when its node ends.
 */
export function createWatch(remote: ClientRemote): WatchWorkspaceDirectory {
  return async function* (sessionId, path, signal) {
    const aborted = (): boolean => signal.aborted
    if (aborted()) return
    const stream = remote.$stream<WorkspaceFileWatchFrame>({
      name: `directory ${path}`,
      open: lifetime => remote.workspaceFiles.changes(sessionId, path, lifetime),
      ended: () => new Error(`Directory watch ended: ${path}`),
    })
    const abort = (): void => { void stream.dispose() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      for await (const item of stream) {
        if (aborted()) return
        if (item.value.kind === 'ready') item.accept()
        yield item.value.kind
      }
    } finally {
      signal.removeEventListener('abort', abort)
      await stream.dispose()
    }
  }
}

/**
 * One directory listing, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it: the same path means different directories in different sessions.
 * A Remote call does not reject — the result carries the failure.
 */
export type ListWorkspaceDirectory = (
  sessionId: SessionId,
  path: string,
  signal: AbortSignal,
) => Promise<RemoteResult<DirLevel>>

/**
 * The slice of the Client Remote face this package calls: the `workspaceFiles`
 * namespace's `list` and `search`, exactly as the Host's generated client declares them.
 */
export type WorkspaceFilesListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list' | 'search'>
}

/**
 * Bind the listing to one Remote face, keeping only what the tree stores.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the listing the tree's face performs.
 */
export function createList(remote: WorkspaceFilesListRemote): ListWorkspaceDirectory {
  return async (sessionId, path, signal) => {
    const result = await remote.workspaceFiles.list(sessionId, path, signal)
    if (!result.ok) return result
    return { ok: true, value: { entries: result.value.entries, truncated: result.value.truncated } }
  }
}

/**
 * One workspace search, bound to a Remote face.
 *
 * The session travels with the call because the endpoint resolves the workspace
 * root from it. A Remote call does not reject — the result carries the failure.
 */
export type SearchWorkspaceFiles = (
  sessionId: SessionId,
  request: WorkspaceFileSearchRequest,
  signal: AbortSignal,
) => Promise<RemoteResult<WorkspaceFileSearchResult>>

/**
 * Bind the search to one Remote face.
 * @param remote - the Client Remote face carrying the `workspaceFiles` namespace.
 * @returns the search the tab's search box performs.
 */
export function createSearch(remote: WorkspaceFilesListRemote): SearchWorkspaceFiles {
  return (sessionId, request, signal) => remote.workspaceFiles.search(sessionId, request, signal)
}

/**
 * The absolute path of one child entry.
 *
 * Joined with `/` whatever the parent's separators: the Host resolves mixed
 * separators, and the tree only needs a stable key.
 * @param parent - absolute path of the listed directory.
 * @param name - the entry's basename.
 * @returns the child's absolute path.
 */
export function childPath(parent: string, name: string): string {
  return `${parent.replace(/[/\\]+$/, '')}/${name}`
}

/** The tree's injected business face, as the body receives it. */
export interface FilesInjected {
  /** Refresh the open directory tree. @param tabId - owning tab. */
  readonly refresh: (tabId: TabId) => void
  /** Control automatic rereads without closing watches. @param tabId - owning tab. @param enabled - automatic-refresh setting. */
  readonly setAutoRefresh: (tabId: TabId, enabled: boolean) => void
  /**
   * Seed this tab's tree and list its root.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the workspace root.
   * @param signal - the tab record's lifetime.
   */
  readonly start: (tabId: TabId, root: string, signal: AbortSignal) => void
  /**
   * Replace the open tree root after its previous watches have closed.
   * @param tabId - the tab being drawn.
   * @param root - absolute path of the new tree root.
   * @param signal - the tab record's lifetime.
   * @returns after the previous tree is closed and the new tree is opened.
   */
  readonly changeRoot: (tabId: TabId, root: string, signal: AbortSignal) => Promise<void>
  /**
   * List one directory into the store.
   * @param tabId - the tab being drawn.
   * @param path - absolute directory path.
   * @param signal - the tab record's lifetime.
   */
  readonly load: (tabId: TabId, path: string, signal: AbortSignal) => void
  /**
   * Open or collapse one directory, retaining intent during ancestor restoration.
   * @param tabId - the tab being drawn.
   * @param parentPath - the listed parent directory's exact tree key.
   * @param path - absolute directory path.
   * @param expanded - current expansion preferences, including descendants to restore.
   * @param signal - the tab record's lifetime.
   */
  readonly toggle: (tabId: TabId, parentPath: string, path: string, expanded: readonly string[], signal: AbortSignal) => void
  /**
   * Search the session workspace by file name or content, independent of the tree's loaded levels.
   * @param request - the match mode and query text.
   * @param signal - caller cancellation; a settlement after abort is dropped by the caller.
   * @returns the bounded hits, or the failure.
   */
  readonly search: (request: WorkspaceFileSearchRequest, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileSearchResult>>
}

/**
 * Bind the tree's face to one directory listing and one search.
 * @param list - the bound `workspaceFiles.list` call.
 * @param watch - target-scoped directory observation.
 * @param search - the bound `workspaceFiles.search` call.
 * @returns the Slot `inject` factory: session and bound actions in, face out.
 */
export function filesFace(
  list: ListWorkspaceDirectory,
  watch: WatchWorkspaceDirectory,
  search: SearchWorkspaceFiles,
): (sessionId: SessionId, actions: BoundActions<ReturnType<typeof createFilesStore>>) => FilesInjected {
  return (
    sessionId: SessionId,
    actions: BoundActions<ReturnType<typeof createFilesStore>>,
  ): FilesInjected => {
    type RootTree = {
      readonly path: string
      readonly epoch: number
      readonly node: DirectoryNode
      automatic: boolean
      closing?: Promise<void>
    }
    type TabTree = { readonly signal: AbortSignal; root?: RootTree; request: number; transitioning: boolean }
    /** Per tab and path, the latest listing that may publish. */
    const generations = new Map<TabId, Map<string, number>>()
    const epochs = new Map<TabId, number>()
    const trees = new Map<TabId, TabTree>()
    let nextEpoch = 0
    let nextRequest = 0
    const nextGeneration = (tabId: TabId, path: string): number => {
      const byPath = generations.get(tabId) ?? new Map<string, number>()
      generations.set(tabId, byPath)
      const generation = (byPath.get(path) ?? 0) + 1
      byPath.set(path, generation)
      return generation
    }
    const closeTree = (root: RootTree): Promise<void> => {
      root.closing ??= root.node.close()
      return root.closing
    }
    const load = async (tabId: TabId, path: string, signal: AbortSignal): Promise<DirLevel | undefined> => {
      if (signal.aborted) return
      const tree = trees.get(tabId)
      if (tree === undefined || tree.transitioning) return
      const epoch = epochs.get(tabId)
      if (epoch === undefined) return
      const generation = nextGeneration(tabId, path)
      actions.loading(tabId, path)
      return list(sessionId, path, signal).then((result) => {
        // Both the root epoch and level generation must still be current.
        if (signal.aborted || epochs.get(tabId) !== epoch || generations.get(tabId)?.get(path) !== generation) return
        if (result.ok) actions.loaded(tabId, path, result.value)
        else actions.failed(tabId, path, result.error)
        return result.ok ? result.value : undefined
      })
    }
    const openTree = (tabId: TabId, tree: TabTree, path: string, automatic: boolean, epoch: number): RootTree => {
      let root!: RootTree
      const node = new DirectoryNode(path,
        (childPath, lifetime) => load(tabId, childPath, lifetime),
        (childPath, lifetime) => watch(sessionId, childPath, lifetime),
        (childPath, error) => {
          if (tree.signal.aborted || trees.get(tabId) !== tree || tree.root !== root || epochs.get(tabId) !== epoch) return
          actions.failed(tabId, childPath, new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}))
        }, tree.signal,
      )
      root = { path, epoch, node, automatic }
      node.setAutomatic(automatic)
      return root
    }
    const changeRoot = async (tabId: TabId, path: string, signal: AbortSignal): Promise<void> => {
      if (signal.aborted) return
      const tree = trees.get(tabId)
      const previous = tree?.root
      if (tree === undefined || tree.signal !== signal || previous === undefined) return
      if (!tree.transitioning && previous.path === path) return
      const request = ++nextRequest
      const epoch = ++nextEpoch
      tree.request = request
      tree.transitioning = true
      epochs.set(tabId, epoch)
      try {
        await closeTree(previous)
      } catch (error) {
        if (!signal.aborted && trees.get(tabId) === tree && tree.request === request && tree.root === previous) {
          const replacement = openTree(tabId, tree, previous.path, previous.automatic, epoch)
          tree.root = replacement
          tree.transitioning = false
          generations.delete(tabId)
          replacement.node.open()
        }
        throw error
      }
      if (signal.aborted || trees.get(tabId) !== tree || tree.request !== request || tree.root !== previous) return
      const replacement = openTree(tabId, tree, path, previous.automatic, epoch)
      tree.root = replacement
      tree.transitioning = false
      generations.delete(tabId)
      actions.changeRoot(tabId, path)
      replacement.node.open()
    }
    return {
      refresh: (tabId) => { void trees.get(tabId)?.root?.node.refreshTree() },
      setAutoRefresh: (tabId, enabled) => {
        actions.autoRefresh(tabId, enabled)
        const tree = trees.get(tabId)
        const root = tree?.root
        if (tree === undefined || root === undefined) return
        root.automatic = enabled
        if (!tree.transitioning) root.node.setAutomatic(enabled)
      },
      start(tabId, root, signal) {
        if (signal.aborted) return
        const previous = trees.get(tabId)
        if (previous !== undefined) {
          previous.request = ++nextRequest
          previous.transitioning = false
          const previousRoot = previous.root
          if (previousRoot !== undefined) void closeTree(previousRoot)
        }
        actions.start(tabId, root)
        generations.delete(tabId)
        const tree: TabTree = { signal, request: ++nextRequest, transitioning: false }
        const epoch = ++nextEpoch
        const record = openTree(tabId, tree, root, true, epoch)
        tree.root = record
        trees.set(tabId, tree)
        epochs.set(tabId, record.epoch)
        signal.addEventListener('abort', () => {
          if (trees.get(tabId) !== tree) return
          tree.request = ++nextRequest
          tree.transitioning = false
          trees.delete(tabId)
          epochs.delete(tabId)
          generations.delete(tabId)
          actions.forget(tabId)
          const root = tree.root
          if (root !== undefined) void closeTree(root)
        }, { once: true })
        record.node.open()
      },
      changeRoot,
      load: (tabId, path, signal) => { void load(tabId, path, signal) },
      search: (request, signal) => search(sessionId, request, signal),
      toggle(tabId, parentPath, path, expanded, signal) {
        if (signal.aborted) return
        const root = trees.get(tabId)?.root?.node
        if (root === undefined) return
        const parent = root.find(parentPath)
        if (parent === undefined && !expanded.includes(parentPath)) return
        const collapsing = expanded.includes(path)
        const next = collapsing ? expanded.filter(value => value !== path) : [...expanded, path]
        root.setExpanded(next)
        if (collapsing) void parent?.collapse(path)
        else parent?.expand(path, next)
        actions.toggled(tabId, path)
      },
    }
  }
}
