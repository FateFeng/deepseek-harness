/** The `search` endpoint: bounded, workspace-scoped name and content matching. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, type FsTarget } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceFiles, type WorkspaceFileScope } from '../src/index.ts'
import { failureOf, openWorkspace, signal, type Harness } from './harness.ts'

let harness: Harness
let workspace: string
let outside: string

beforeEach(async () => {
  harness = await openWorkspace('dsh-workspace-files-search-')
  workspace = harness.workspace
  outside = harness.outside
})

afterEach(async () => {
  await harness.dispose()
})

const endpoint = (caps?: Parameters<Harness['endpoint']>[0]): ReturnType<Harness['endpoint']> => harness.endpoint(caps)

describe('workspaceFiles.search — name mode', () => {
  it('finds matching basenames recursively and case-insensitively, files only', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'ChatAgent.kt'), '')
    await writeFile(join(workspace, 'src', 'chat.ts'), '')
    await writeFile(join(workspace, 'README.md'), '')
    await mkdir(join(workspace, 'chat-assets'))
    await symlink(join(workspace, 'missing'), join(workspace, 'dangling'))
    const result = await endpoint().search(harness.scope, { mode: 'name', query: 'CHAT' }, signal())
    expect(result.truncated).toBe(false)
    expect(result.matches).toEqual([{ path: 'src/chat.ts' }, { path: 'src/ChatAgent.kt' }])
  })

  it('matches a binary file by name without reading it', async () => {
    await writeFile(join(workspace, 'data.bin'), Buffer.from([0, 1, 2, 3]))
    const result = await endpoint().search(harness.scope, { mode: 'name', query: 'data' }, signal())
    expect(result.matches).toEqual([{ path: 'data.bin' }])
  })

  it('answers an empty tree with no hits and no cut', async () => {
    const result = await endpoint().search(harness.scope, { mode: 'name', query: 'anything' }, signal())
    expect(result).toEqual({ matches: [], truncated: false })
  })
})

describe('workspaceFiles.search — content mode', () => {
  it('matches case-insensitively with 1-based lines and trimmed previews', async () => {
    await mkdir(join(workspace, 'src'))
    await writeFile(join(workspace, 'src', 'a.txt'), 'hello\n  World HELLO again  \nbye\n', 'utf8')
    await writeFile(join(workspace, 'b.txt'), 'nothing here', 'utf8')
    const result = await endpoint().search(harness.scope, { mode: 'content', query: 'hello' }, signal())
    expect(result.truncated).toBe(false)
    expect(result.matches).toEqual([
      { path: 'src/a.txt', line: 1, preview: 'hello' },
      { path: 'src/a.txt', line: 2, preview: 'World HELLO again' },
    ])
  })

  it('matches the final line without a newline and strips CR from CRLF files', async () => {
    await writeFile(join(workspace, 'tail.txt'), 'first\nneedle at tail', 'utf8')
    await writeFile(join(workspace, 'crlf.txt'), 'a\r\nneedle b\r\n', 'utf8')
    const result = await endpoint().search(harness.scope, { mode: 'content', query: 'needle' }, signal())
    expect(result.matches).toEqual([
      { path: 'crlf.txt', line: 2, preview: 'needle b' },
      { path: 'tail.txt', line: 2, preview: 'needle at tail' },
    ])
  })

  it('skips binary and non-UTF-8 files entirely', async () => {
    await writeFile(join(workspace, 'data.bin'), Buffer.from([110, 101, 101, 100, 108, 101, 0, 33]))
    await writeFile(join(workspace, 'raw.dat'), Buffer.from([0xff, 0xfe, 0xfd, 0xfb]))
    // A NUL past the backend's binary sample still decodes, so the search does its own NUL gate.
    await writeFile(join(workspace, 'late.bin'), Buffer.concat([
      Buffer.from(`needle first\n${'a'.repeat(9000)}\n`, 'utf8'),
      Buffer.from([0]),
      Buffer.from('needle later\n', 'utf8'),
    ]))
    await writeFile(join(workspace, 'plain.txt'), 'needle', 'utf8')
    const result = await endpoint().search(harness.scope, { mode: 'content', query: 'needle' }, signal())
    expect(result.matches).toEqual([{ path: 'plain.txt', line: 1, preview: 'needle' }])
  })

  it('cuts a line preview at the protocol length', async () => {
    const line = `needle${'x'.repeat(400)}`
    await writeFile(join(workspace, 'long.txt'), line, 'utf8')
    const result = await endpoint().search(harness.scope, { mode: 'content', query: 'needle' }, signal())
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]!.preview).toBe(line.slice(0, 240))
  })

  it('searches only the first bytes of a file larger than the per-file cap', async () => {
    await writeFile(join(workspace, 'big.txt'), 'needle', 'utf8')
    const capped = await harness.endpoint({ maxSearchFileBytes: 1 }).search(harness.scope, { mode: 'content', query: 'needle' }, signal())
    expect(capped).toEqual({ matches: [], truncated: false })
  })
})

describe('workspaceFiles.search — containment and loops', () => {
  it('never descends into excluded directories', async () => {
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true })
    await writeFile(join(workspace, 'node_modules', 'pkg', 'needle.js'), '')
    await mkdir(join(workspace, '.git'))
    await writeFile(join(workspace, '.git', 'needle.txt'), '')
    await writeFile(join(workspace, 'needle.ts'), '')
    const result = await endpoint().search(harness.scope, { mode: 'name', query: 'needle' }, signal())
    expect(result.matches).toEqual([{ path: 'needle.ts' }])
  })

  it('does not follow a symlinked directory out of the workspace', async () => {
    await writeFile(join(outside, 'secret.txt'), 'needle', 'utf8')
    await symlink(outside, join(workspace, 'link-out'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await endpoint().search(harness.scope, { mode: 'content', query: 'needle' }, signal())
    expect(result).toEqual({ matches: [], truncated: false })
  })

  it('terminates on a directory cycle', async () => {
    await writeFile(join(workspace, 'needle.txt'), '')
    await symlink(workspace, join(workspace, 'loop'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await endpoint().search(harness.scope, { mode: 'name', query: 'needle' }, signal())
    expect(result).toEqual({ matches: [{ path: 'needle.txt' }], truncated: false })
  })
})

describe('workspaceFiles.search — request validation and caps', () => {
  it('refuses a blank or NUL-carrying query', async () => {
    expect((await failureOf(endpoint().search(harness.scope, { mode: 'name', query: '  ' }, signal()))).code).toBe('gateway/bad-request')
    expect((await failureOf(endpoint().search(harness.scope, { mode: 'content', query: 'a\0b' }, signal()))).code).toBe('gateway/bad-request')
  })

  it('stops at the result cap and reports the cut', async () => {
    await writeFile(join(workspace, 'a.txt'), 'needle\nneedle\n', 'utf8')
    await writeFile(join(workspace, 'z.txt'), 'needle\n', 'utf8')
    const result = await harness.endpoint({ maxSearchResults: 1 }).search(harness.scope, { mode: 'content', query: 'needle' }, signal())
    expect(result.truncated).toBe(true)
    expect(result.matches).toEqual([{ path: 'a.txt', line: 1, preview: 'needle' }])
  })

  it('stops at the inspected-entry cap and reports the cut', async () => {
    await writeFile(join(workspace, 'a.txt'), '')
    await writeFile(join(workspace, 'z-needle.txt'), '')
    const result = await harness.endpoint({ maxSearchEntries: 1 }).search(harness.scope, { mode: 'name', query: 'needle' }, signal())
    expect(result).toEqual({ matches: [], truncated: true })
  })
})

describe('workspaceFiles.search — backend failures', () => {
  it('propagates a read failure that is not a decode refusal', async () => {
    const target = (path: string): FsTarget => ({ targetKey: FsTargetKey(path), displayPath: path })
    const ctx = new Context()
    ctx.provide('fs', {
      resolve: async (path: string) => target(path),
      processPath: (value: FsTarget) => value.displayPath,
      fileUrl: (value: FsTarget) => `file://${value.displayPath}`,
      contains: () => true,
      listDir: async () => [{ name: 'bad.txt', type: 'file', target: target('/w/bad.txt') }],
      streamText: async () => (async function* (): AsyncGenerator<string> { throw new Error('disk gone') })(),
    } as never)
    ctx.provide('sandboxPolicy', { workspaceRoot: '/w' } as never)
    const service = new WorkspaceFiles(ctx, {
      maxBytes: 1024, maxFileBytes: 1024, maxLines: 100, maxEntries: 100,
      maxSearchResults: 10, maxSearchEntries: 100, maxSearchFileBytes: 1024,
      searchExcludedDirectories: ['.git', 'node_modules'],
    })
    const scope: WorkspaceFileScope = { sessionId: SessionId('s-search-failure'), workspaceRoot: '/w' }
    await expect(service.search(scope, { mode: 'content', query: 'x' }, signal())).rejects.toThrow('disk gone')
    await ctx.fiber.dispose()
  })
})
