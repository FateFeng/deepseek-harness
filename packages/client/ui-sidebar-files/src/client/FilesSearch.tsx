/**
 * The files tab's workspace search: one query box with a name/content mode
 * toggle, and the bounded result list that replaces the tree while a query is
 * active. Pure props throughout; the body owns the state and the face call.
 */
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import clsx from 'clsx'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceFileSearchMatch } from '@deepseek-ai/dsh-api-workspace-files/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { FileTypeIcon, IconSearchOutlineRegular, Input, classifyFileType, rankByName } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from './locales.ts'
import css from './FilesBody.module.css'

/** What the query matches: file basenames, or lines of file content. */
export type FilesSearchMode = 'name' | 'content'

/** One search's settled state, keyed by the request it answers. */
export interface FilesSearchOutcome {
  /** `<mode>:<query>` of the request this outcome answers. */
  readonly key: string
  readonly searching: boolean
  readonly matches: readonly WorkspaceFileSearchMatch[]
  readonly truncated: boolean
  readonly failure?: RemoteFailure | undefined
}

/** The displayed search state: the settled outcome or a searching placeholder over the previous hits. */
export type FilesSearchShown = Pick<FilesSearchOutcome, 'searching' | 'matches' | 'truncated' | 'failure'>

/**
 * The displayed state of the live query: the settled outcome when it answers
 * this key, else a searching placeholder that keeps the previous hits visible.
 * @param settled - the last settled outcome, when any.
 * @param key - the live `<mode>:<query>`.
 * @returns what the results list draws right now.
 */
export function shownSearch(settled: FilesSearchOutcome | undefined, key: string): FilesSearchShown {
  if (settled !== undefined && settled.key === key) return settled
  return { searching: true, matches: settled?.matches ?? [], truncated: settled?.truncated ?? false }
}

/** The basename of a `/`-joined workspace path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The parent directory of a `/`-joined workspace path, empty at the root. */
export function dirName(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? '' : path.slice(0, cut)
}

/**
 * Order name hits for display: fuzzy rank on the basename, ties keep walk order.
 * @param matches - name-mode hits in walk order.
 * @param query - the live query text.
 * @returns the hits in display order.
 */
export function rankNameMatches(matches: readonly WorkspaceFileSearchMatch[], query: string): WorkspaceFileSearchMatch[] {
  return rankByName(matches.map(match => ({ name: baseName(match.path), match })), query).map(item => item.match)
}

/**
 * Group content hits by file for display. The walk visits each file once, so
 * a file's hits are always consecutive.
 * @param matches - content-mode hits in walk order.
 * @returns per-file groups in first-hit order.
 */
export function groupContentMatches(matches: readonly WorkspaceFileSearchMatch[]): { path: string; matches: WorkspaceFileSearchMatch[] }[] {
  const groups: { path: string; matches: WorkspaceFileSearchMatch[] }[] = []
  for (const match of matches) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.path === match.path) last.matches.push(match)
    else groups.push({ path: match.path, matches: [match] })
  }
  return groups
}

/** The search row under the files tab header: the query box and the mode toggle. */
export function FilesSearchBar({ query, mode, onQuery, onMode, onOpenFirst, t }: {
  readonly query: string
  readonly mode: FilesSearchMode
  readonly onQuery: (query: string) => void
  readonly onMode: (mode: FilesSearchMode) => void
  readonly onOpenFirst: () => void
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape' && query !== '') { event.stopPropagation(); onQuery('') }
    else if (event.key === 'Enter') onOpenFirst()
  }
  return (
    <div className={css.searchBar}>
      <Input
        icon={<IconSearchOutlineRegular />}
        value={query}
        placeholder={t('search.placeholder')}
        aria-label={t('search.placeholder')}
        data-files-search
        onChange={(event: ChangeEvent<HTMLInputElement>) => { onQuery(event.currentTarget.value) }}
        onKeyDown={onKeyDown}
      />
      <div className={css.searchModes} role="group" aria-label={t('search.mode')}>
        <button type="button" className={css.searchMode} aria-pressed={mode === 'name'}
          data-files-search-mode="name" onClick={() => { onMode('name') }}>{t('search.mode.name')}</button>
        <button type="button" className={css.searchMode} aria-pressed={mode === 'content'}
          data-files-search-mode="content" onClick={() => { onMode('content') }}>{t('search.mode.content')}</button>
      </div>
    </div>
  )
}

/** The search outcome replacing the tree while a query is active. */
export function FilesSearchResults({ mode, shown, onOpen, t }: {
  readonly mode: FilesSearchMode
  readonly shown: FilesSearchShown
  readonly onOpen: (path: string, line?: number) => void
  readonly t: TranslateNS<'sidebarFiles'>
}): ReactNode {
  const failure = shown.failure
  return (
    <div data-files-search-results>
      {shown.searching && <p className={css.note} data-files-search-row="searching">{t('search.searching')}</p>}
      {failure !== undefined && <p className={css.note} role="alert" data-files-search-row="failed">{t('search.failed', { message: failure.message })}</p>}
      {!shown.searching && failure === undefined && shown.matches.length === 0
        && <p className={css.note} data-files-search-row="empty">{t('search.empty')}</p>}
      {failure === undefined && (mode === 'name'
        ? <NameResults matches={shown.matches} onOpen={onOpen} />
        : <ContentResults matches={shown.matches} onOpen={onOpen} />)}
      {shown.truncated && <p className={css.note} data-files-search-row="truncated">{t('search.truncated')}</p>}
    </div>
  )
}

/** Name hits: one row per file, ranked by the body. */
function NameResults({ matches, onOpen }: {
  matches: readonly WorkspaceFileSearchMatch[]
  onOpen: (path: string) => void
}): ReactNode {
  return (
    <ul className={css.level}>
      {matches.map((match) => {
        const name = baseName(match.path)
        const dir = dirName(match.path)
        return (
          <li key={match.path} className={css.item}>
            <button type="button" className={css.row} data-files-search-result={match.path}
              onClick={() => { onOpen(match.path) }}>
              <FileTypeIcon kind={classifyFileType(name)} size={16} className={css.fileIcon} />
              <span className={css.name}>{name}</span>
              {dir !== '' && <span className={css.resultDir}>{dir}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Content hits: one file row, then its line rows with previews. */
function ContentResults({ matches, onOpen }: {
  matches: readonly WorkspaceFileSearchMatch[]
  onOpen: (path: string, line?: number) => void
}): ReactNode {
  return (
    <ul className={css.level}>
      {groupContentMatches(matches).map((group) => {
        const name = baseName(group.path)
        const dir = dirName(group.path)
        return (
          <li key={group.path} className={css.item}>
            <button type="button" className={css.row} data-files-search-result={group.path}
              onClick={() => { onOpen(group.path) }}>
              <FileTypeIcon kind={classifyFileType(name)} size={16} className={css.fileIcon} />
              <span className={css.name}>{name}</span>
              {dir !== '' && <span className={css.resultDir}>{dir}</span>}
            </button>
            <ul className={css.level}>
              {group.matches.map(match => match.line === undefined ? null : (
                <li key={match.line}>
                  <button type="button" className={clsx(css.row, css.resultMatch)}
                    data-files-search-result={`${group.path}:${match.line}`}
                    onClick={() => { onOpen(group.path, match.line) }}>
                    <span className={css.resultLineNumber}>{match.line}</span>
                    <span className={css.resultPreview}>{match.preview}</span>
                  </button>
                </li>
              ))}
            </ul>
          </li>
        )
      })}
    </ul>
  )
}
