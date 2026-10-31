// @vitest-environment jsdom
/** The files tab's workspace search: helpers, the search bar, results, and the body's wiring. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { RemoteError, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { WorkspaceFileSearchMatch } from '@deepseek-ai/dsh-api-workspace-files/types'
import {
  FilesSearchBar, FilesSearchResults, baseName, dirName, groupContentMatches, rankNameMatches, shownSearch,
} from '../src/client/FilesSearch.tsx'
import type { FilesSearchOutcome } from '../src/client/FilesSearch.tsx'
import { zh } from '../src/client/locales.ts'
import { mountBody, SESSION } from './mount.client.tsx'

const t = makeTranslate(zh)

afterEach(() => { cleanup() })

it('splits workspace paths into basename and directory', () => {
  expect(baseName('src/deep/a.ts')).toBe('a.ts')
  expect(baseName('a.ts')).toBe('a.ts')
  expect(dirName('src/deep/a.ts')).toBe('src/deep')
  expect(dirName('a.ts')).toBe('')
})

it('ranks name hits by the basename and keeps walk order on ties', () => {
  const matches: WorkspaceFileSearchMatch[] = [
    { path: 'src/chat-utils.ts' },
    { path: 'docs/Chat.ts' },
    { path: 'src/achat.ts' },
  ]
  expect(rankNameMatches(matches, 'chat').map(match => match.path)).toEqual(['src/chat-utils.ts', 'docs/Chat.ts', 'src/achat.ts'])
  expect(rankNameMatches(matches, '').map(match => match.path)).toEqual(['src/chat-utils.ts', 'docs/Chat.ts', 'src/achat.ts'])
})

it('groups content hits by file, keeping first-hit order', () => {
  const matches: WorkspaceFileSearchMatch[] = [
    { path: 'a.ts', line: 1, preview: 'x' },
    { path: 'a.ts', line: 5, preview: 'y' },
    { path: 'b.ts', line: 2, preview: 'z' },
  ]
  expect(groupContentMatches(matches)).toEqual([
    { path: 'a.ts', matches: [matches[0], matches[1]] },
    { path: 'b.ts', matches: [matches[2]] },
  ])
})

it('shows the settled outcome for the live key and a searching placeholder otherwise', () => {
  const settled: FilesSearchOutcome = { key: 'name:chat', searching: false, matches: [{ path: 'a.ts' }], truncated: true }
  expect(shownSearch(settled, 'name:chat')).toBe(settled)
  expect(shownSearch(settled, 'content:chat')).toEqual({ searching: true, matches: settled.matches, truncated: true })
  expect(shownSearch(undefined, 'name:x')).toEqual({ searching: true, matches: [], truncated: false })
})

function bar(query: string, mode: 'name' | 'content' = 'name') {
  const onQuery = vi.fn(), onMode = vi.fn(), onOpenFirst = vi.fn()
  const view = render(<FilesSearchBar query={query} mode={mode} onQuery={onQuery} onMode={onMode} onOpenFirst={onOpenFirst} t={t} />)
  return { view, onQuery, onMode, onOpenFirst }
}

it('forwards typing, mode switches, Enter and Escape from the search bar', () => {
  const h = bar('chat')
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'chat2' } })
  expect(h.onQuery).toHaveBeenCalledWith('chat2')
  fireEvent.click(h.view.getByRole('button', { name: zh['search.mode.content'] }))
  expect(h.onMode).toHaveBeenCalledWith('content')
  expect(h.view.getByRole('button', { name: zh['search.mode.name'] }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(h.view.getByRole('button', { name: zh['search.mode.name'] }))
  expect(h.onMode).toHaveBeenLastCalledWith('name')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(h.onOpenFirst).toHaveBeenCalledOnce()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(h.onQuery).toHaveBeenLastCalledWith('')
  h.view.unmount()
  const empty = bar('')
  fireEvent.keyDown(empty.view.getByRole('textbox'), { key: 'Escape' })
  expect(empty.onQuery).not.toHaveBeenCalled()
})

it('renders name hits with their directories and opens one on click', () => {
  const onOpen = vi.fn()
  const shown = { searching: false, matches: [{ path: 'src/a.ts' }, { path: 'b.ts' }], truncated: false }
  const view = render(<FilesSearchResults mode="name" shown={shown} onOpen={onOpen} t={t} />)
  const row = view.getByText('a.ts')
  expect(view.getByText('src')).toBeDefined()
  fireEvent.click(row)
  expect(onOpen).toHaveBeenCalledWith('src/a.ts')
  expect(onOpen).toHaveBeenCalledOnce()
})

it('renders content hits grouped by file and opens one at its line', () => {
  const onOpen = vi.fn()
  const matches: WorkspaceFileSearchMatch[] = [
    { path: 'src/a.ts', line: 3, preview: 'val response = chat' },
    { path: 'src/a.ts', line: 9, preview: 'chat again' },
    { path: 'src/b.ts' },
  ]
  const view = render(<FilesSearchResults mode="content" shown={{ searching: false, matches, truncated: true }} onOpen={onOpen} t={t} />)
  fireEvent.click(view.getByText('val response = chat'))
  expect(onOpen).toHaveBeenCalledWith('src/a.ts', 3)
  fireEvent.click(view.getByText('a.ts'))
  expect(onOpen).toHaveBeenCalledWith('src/a.ts')
  // A hit without a line renders only its file row.
  fireEvent.click(view.getByText('b.ts'))
  expect(onOpen).toHaveBeenCalledWith('src/b.ts')
  expect(view.getByText(zh['search.truncated'])).toBeDefined()
})

it('renders searching, empty and failure states', () => {
  const onOpen = vi.fn()
  const searching = render(<FilesSearchResults mode="name" shown={{ searching: true, matches: [], truncated: false }} onOpen={onOpen} t={t} />)
  expect(searching.getByText(zh['search.searching'])).toBeDefined()
  searching.unmount()
  const empty = render(<FilesSearchResults mode="name" shown={{ searching: false, matches: [], truncated: false }} onOpen={onOpen} t={t} />)
  expect(empty.getByText(zh['search.empty'])).toBeDefined()
  empty.unmount()
  const failure = new RemoteError('gateway/internal', 'backend down', {})
  const failed = render(<FilesSearchResults mode="content" shown={{ searching: false, matches: [], truncated: false, failure }} onOpen={onOpen} t={t} />)
  expect(failed.getByRole('alert').textContent).toContain('backend down')
})

it('debounces the query, searches by name, and opens a hit into the sidebar', async () => {
  const h = mountBody()
  h.search.mockResolvedValue({ ok: true, value: { matches: [{ path: 'src/chat.ts' }, { path: 'README-chat.md' }], truncated: false } })
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'c' } })
  fireEvent.change(input, { target: { value: 'chat' } })
  await vi.waitFor(() => { expect(h.search).toHaveBeenCalledOnce() })
  expect(h.search).toHaveBeenCalledWith(SESSION, { query: 'chat', mode: 'name' }, expect.anything())
  const row = await h.view.findByText('chat.ts')
  expect(h.view.getByText('src')).toBeDefined()
  expect(h.view.getByText('README-chat.md')).toBeDefined()
  fireEvent.click(row)
  expect(h.tabActions.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s-test/src/chat.ts')
})

it('switches to content mode and opens a hit at its line', async () => {
  const h = mountBody()
  h.search.mockResolvedValue({ ok: true, value: { matches: [{ path: 'src/a.ts', line: 7, preview: 'const chat = 1' }], truncated: false } })
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'chat' } })
  await vi.waitFor(() => { expect(h.search).toHaveBeenCalledWith(SESSION, { query: 'chat', mode: 'name' }, expect.anything()) })
  fireEvent.click(h.view.getByRole('button', { name: zh['search.mode.content'] }))
  await vi.waitFor(() => { expect(h.search).toHaveBeenCalledWith(SESSION, { query: 'chat', mode: 'content' }, expect.anything()) })
  const preview = await h.view.findByText('const chat = 1')
  fireEvent.click(preview)
  expect(h.tabActions.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s-test/src/a.ts', { params: { line: 7 } })
})

it('opens the first ranked hit on Enter', async () => {
  const h = mountBody()
  h.search.mockResolvedValue({ ok: true, value: { matches: [{ path: 'src/z-chat.ts' }, { path: 'src/chat.ts' }], truncated: false } })
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'chat' } })
  await h.view.findByText('chat.ts')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(h.tabActions.openResource).toHaveBeenCalledWith('dsh-resource://file/session/s-test/src/chat.ts')
})

it('keeps previous hits while a follow-up search runs, and Escape returns to the tree', async () => {
  const h = mountBody()
  h.search.mockResolvedValueOnce({ ok: true, value: { matches: [{ path: 'src/chat.ts' }], truncated: false } })
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'chat' } })
  await h.view.findByText('chat.ts')
  h.search.mockReturnValueOnce(new Promise(() => {}))
  fireEvent.change(input, { target: { value: 'chat2' } })
  await h.view.findByText(zh['search.searching'])
  expect(h.view.getByText('chat.ts')).toBeDefined()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect((input as HTMLInputElement).value).toBe('')
  expect(h.view.queryByText(zh['search.searching'])).toBeNull()
})

it('reports a search failure in place', async () => {
  const h = mountBody()
  h.search.mockResolvedValue({ ok: false, error: new RemoteError('gateway/internal', 'backend down', {}) })
  fireEvent.change(h.view.getByRole('textbox', { name: zh['search.placeholder'] }), { target: { value: 'x' } })
  await h.view.findByRole('alert')
  expect(h.view.getByRole('alert').textContent).toContain('backend down')
})

it('does not search for a blank query', async () => {
  const h = mountBody()
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: '   ' } })
  await new Promise(resolve => setTimeout(resolve, 400))
  expect(h.search).not.toHaveBeenCalled()
  expect(h.view.queryByText(zh['search.searching'])).toBeNull()
})

it('opens nothing on Enter before any hit arrives', async () => {
  const h = mountBody()
  h.search.mockReturnValue(new Promise(() => {}))
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'chat' } })
  await h.view.findByText(zh['search.searching'])
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(h.tabActions.openResource).not.toHaveBeenCalled()
})

it('drops a settlement that lands after the query was aborted', async () => {
  const h = mountBody()
  let settle: ((result: { ok: true; value: { matches: never[]; truncated: false } }) => void) | undefined
  h.search.mockReturnValue(new Promise((resolve) => { settle = resolve }))
  const input = h.view.getByRole('textbox', { name: zh['search.placeholder'] })
  fireEvent.change(input, { target: { value: 'chat' } })
  await vi.waitFor(() => { expect(h.search).toHaveBeenCalledOnce() })
  h.view.unmount()
  settle?.({ ok: true, value: { matches: [], truncated: false } })
  await Promise.resolve()
})
