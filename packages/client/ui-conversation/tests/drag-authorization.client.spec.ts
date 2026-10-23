import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  createWorkspaceReferenceAuthorizer,
  type WorkspaceReferenceListRemote,
} from '../src/client/input/drag-authorization.ts'

const sessionId = 'workspace-session' as SessionId
const signal = new AbortController().signal

function listingRemote() {
  const list = vi.fn(async (_sessionId: SessionId, _path: string, _signal: AbortSignal) => ({
    ok: true as const,
    value: {
      path: '',
      entries: [
        { name: 'notes.data', type: 'file' as const },
        { name: 'research', type: 'directory' as const },
      ],
      truncated: false,
    },
  }))
  return {
    remote: { workspaceFiles: { list } } as unknown as WorkspaceReferenceListRemote,
    list,
  }
}

describe('Host authorization of composer file drops', () => {
  it('proves exact file and directory children through the Host listing endpoint', async () => {
    const { remote, list } = listingRemote()
    const authorize = createWorkspaceReferenceAuthorizer(remote, sessionId)

    await expect(authorize('/home/work/notes.data', 'file', signal)).resolves.toBe(true)
    await expect(authorize('/home/work/research', 'directory', signal)).resolves.toBe(true)

    expect(list).toHaveBeenNthCalledWith(1, sessionId, '/home/work', signal)
    expect(list).toHaveBeenNthCalledWith(2, sessionId, '/home/work', signal)
  })

  it('accepts the Host relative listing path for a selected attached root', async () => {
    const list = vi.fn(async () => ({
      ok: true as const,
      value: {
        path: 'reports',
        entries: [{ name: 'notes.data', type: 'file' as const }],
        truncated: false,
      },
    }))
    const authorize = createWorkspaceReferenceAuthorizer({ workspaceFiles: { list } }, sessionId)

    await expect(authorize('/mnt/attached/reports/notes.data', 'file', signal)).resolves.toBe(true)
    expect(list).toHaveBeenCalledWith(sessionId, '/mnt/attached/reports', signal)
  })

  it('rejects absent children and mismatched file/folder claims', async () => {
    const { remote } = listingRemote()
    const authorize = createWorkspaceReferenceAuthorizer(remote, sessionId)

    await expect(authorize('/home/work/research', 'file', signal)).resolves.toBe(false)
    await expect(authorize('/home/work/missing.txt', 'file', signal)).resolves.toBe(false)
  })

  it('preserves a literal backslash in a POSIX filename', async () => {
    const name = 'notes\\draft.data'
    const list = vi.fn(async (_sessionId: SessionId, path: string, _signal?: AbortSignal) => ({
      ok: true as const,
      value: { path, entries: [{ name, type: 'file' as const }], truncated: false },
    }))
    const authorize = createWorkspaceReferenceAuthorizer({ workspaceFiles: { list } }, sessionId)

    await expect(authorize(`/home/work/${name}`, 'file', signal)).resolves.toBe(true)
    expect(list).toHaveBeenCalledWith(sessionId, '/home/work', signal)
  })

  it('rejects relative paths and lists Windows drive-root children with an absolute parent', async () => {
    const { remote, list } = listingRemote()
    const authorize = createWorkspaceReferenceAuthorizer(remote, sessionId)

    await expect(authorize('workspace/notes.data', 'file', signal)).resolves.toBe(false)
    expect(list).not.toHaveBeenCalled()

    await expect(authorize('C:\\notes.data', 'file', signal)).resolves.toBe(true)
    expect(list).toHaveBeenCalledWith(sessionId, 'C:/', signal)
  })
})
