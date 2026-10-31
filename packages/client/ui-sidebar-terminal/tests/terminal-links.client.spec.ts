// @vitest-environment jsdom
/** `path:line` link detection in terminal output. */
import { expect, it, vi } from 'vitest'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import { cellColumns, findFileLinks, registerTerminalFileLinks, type TerminalLinkHost } from '../src/client/terminal-links.ts'

it('finds grep-style references with relative, absolute and bare paths', () => {
  expect(findFileLinks('src/ChatAgent.kt:12:    suspend fun completeStreaming(')).toEqual([
    { text: 'src/ChatAgent.kt:12', path: 'src/ChatAgent.kt', line: 12, index: 0 },
  ])
  expect(findFileLinks('/home/fate/code/app/Main.ts:3:9: error TS1005')).toEqual([
    { text: '/home/fate/code/app/Main.ts:3:9', path: '/home/fate/code/app/Main.ts', line: 3, index: 0 },
  ])
  expect(findFileLinks('  at run (OpenAiChatAgent.kt:209)')).toEqual([
    { text: 'OpenAiChatAgent.kt:209', path: 'OpenAiChatAgent.kt', line: 209, index: 10 },
  ])
})

it('keeps CJK and segmented paths and finds several references on one line', () => {
  expect(findFileLinks('错误见 src/a.kt:5 或 文档/b.md:6')).toEqual([
    { text: 'src/a.kt:5', path: 'src/a.kt', line: 5, index: 4 },
    { text: '文档/b.md:6', path: '文档/b.md', line: 6, index: 17 },
  ])
})

it('rejects times, versions, URLs and extensionless words', () => {
  expect(findFileLinks('12:34:56')).toEqual([])
  expect(findFileLinks('GET http://localhost:43120/api 200')).toEqual([])
  expect(findFileLinks('plain words only')).toEqual([])
  expect(findFileLinks('nocolon/here')).toEqual([])
  expect(findFileLinks('Makefile:12')).toEqual([])
})

it('measures cell columns with wide code points counted twice', () => {
  expect(cellColumns('abc')).toBe(3)
  expect(cellColumns('技术')).toBe(4)
  expect(cellColumns('a技术b')).toBe(6)
  expect(cellColumns('🙂')).toBe(2)
})

function host(lines: readonly (string | undefined)[]) {
  let provider: ILinkProvider | undefined
  const dispose = vi.fn()
  const terminal: TerminalLinkHost = {
    buffer: {
      active: {
        getLine: (y: number) => {
          const text = lines[y]
          return text === undefined ? undefined : { translateToString: () => text }
        },
      },
    },
    registerLinkProvider(next: ILinkProvider) { provider = next; return { dispose } },
  }
  const links = (y: number): ILink[] | undefined => {
    if (provider === undefined) throw new Error('no link provider was registered')
    let result: ILink[] | undefined
    provider.provideLinks(y, (next) => { result = next })
    return result
  }
  return { terminal, dispose, links }
}

it('maps matches to cell ranges and activates with the live working directory', () => {
  const h = host(['错误: src/a.ts:5 tail'])
  const openFile = vi.fn()
  let cwd: string | undefined = '/workspace'
  const registration = registerTerminalFileLinks(h.terminal, { openFile, cwd: () => cwd })
  const links = h.links(1)
  expect(links).toHaveLength(1)
  expect(links![0]!.range).toEqual({ start: { x: 7, y: 1 }, end: { x: 16, y: 1 } })
  expect(links![0]!.text).toBe('src/a.ts:5')
  cwd = '/moved'
  links![0]!.activate(new MouseEvent('click'), links![0]!.text)
  expect(openFile).toHaveBeenCalledExactlyOnceWith('src/a.ts', { line: 5, cwd: '/moved' })
  registration.dispose()
  expect(h.dispose).toHaveBeenCalledOnce()
})

it('reports no links for a missing line or a line without references', () => {
  const h = host(['plain output'])
  const registration = registerTerminalFileLinks(h.terminal, { openFile: vi.fn(), cwd: () => undefined })
  expect(h.links(1)).toBeUndefined()
  expect(h.links(5)).toBeUndefined()
  registration.dispose()
})
