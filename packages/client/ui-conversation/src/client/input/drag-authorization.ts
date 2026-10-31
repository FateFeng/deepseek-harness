import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The Host directory-list capability needed to prove one dropped child is in the active workspace root. */
export type WorkspaceReferenceListRemote = {
  readonly workspaceFiles: Pick<ClientRemote['workspaceFiles'], 'list'>
}

/** Check that the Host currently lists this exact child with the claimed kind. */
export function createWorkspaceReferenceAuthorizer(
  remote: WorkspaceReferenceListRemote,
  sessionId: SessionId,
): (path: string, kind: 'file' | 'directory', signal: AbortSignal) => Promise<boolean> {
  return async (path, kind, signal) => {
    const child = parentAndName(path)
    if (child === undefined) return false
    try {
      const result = await remote.workspaceFiles.list(sessionId, child.parent, signal)
      // Listing responses name the directory relative to the active workspace
      // root (which may be a Host-selected attached root), not as an absolute path.
      return result.ok
        && result.value.entries.some(entry => entry.name === child.name && entry.type === kind)
    } catch {
      return false
    }
  }
}

/** Split an absolute dropped child path without depending on a Node path implementation in the browser. */
function parentAndName(path: string): { parent: string; name: string } | undefined {
  const windowsPath = /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path)
  const normalized = windowsPath ? path.replaceAll('\\', '/') : path
  if (!normalized.startsWith('/') && !/^[A-Za-z]:\//u.test(normalized)) return undefined
  const slash = normalized.lastIndexOf('/')
  const name = normalized.slice(slash + 1)
  if (slash < 0 || name.length === 0) return undefined
  const parent = slash === 0
    ? '/'
    : slash === 2 && /^[A-Za-z]:\//u.test(normalized)
      ? normalized.slice(0, 3)
      : normalized.slice(0, slash)
  return parent.length === 0 ? undefined : { parent, name }
}

export default createWorkspaceReferenceAuthorizer
