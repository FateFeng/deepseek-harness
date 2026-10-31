/** Clickable `path:line` references detected in terminal output. */
import type { ILink, ILinkProvider } from '@xterm/xterm'

/** The slice of the xterm API the file-link provider reads. */
export interface TerminalLinkHost {
  readonly buffer: { readonly active: { getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined } }
  registerLinkProvider(provider: ILinkProvider): { dispose(): void }
}

/** How a detected file reference opens, and the directory relative paths resolve against. */
export interface TerminalFileLinkCallbacks {
  /**
   * Open the referenced file in the right Sidebar.
   * @param path - the path as printed, workspace-relative or absolute.
   * @param options - the 1-based referenced line and the working directory a relative path resolves against.
   */
  readonly openFile: (path: string, options: { line?: number | undefined; cwd?: string | undefined }) => void
  /** The terminal's working directory at activation time, when the Host reported one. */
  readonly cwd: () => string | undefined
}

/** One `path:line[:column]` reference found in a line of terminal text. */
export interface TerminalFileLinkMatch {
  /** The matched text, including the line and any column number. */
  readonly text: string
  /** The referenced path as printed. */
  readonly path: string
  /** The 1-based referenced line. */
  readonly line: number
  /** The string index where the match starts. */
  readonly index: number
}

/**
 * Characters grep-style tools leave inside a printed path token; parentheses stay
 * outside so stack frames like `(a.ts:1)` link only the path.
 */
const PATH_CHAR = '\\w@+.,%\\[\\]\\-\\u4e00-\\u9fff/'
/** A candidate reference: a path token, a 1-based line, and an optional column. */
const LINK_PATTERN = new RegExp(`[${PATH_CHAR}]+:\\d+(?::\\d+)?`, 'g')

/**
 * Whether a matched token reads as a file path rather than a time, version or URL.
 * @param path - the token before the first colon.
 * @returns true when the token carries a directory separator or a file extension.
 */
export function isFilePathCandidate(path: string): boolean {
  if (path.includes('//')) return false
  return path.includes('/') || /\.[\w$]{1,12}$/.test(path)
}

/**
 * Find every file reference in one line of terminal text.
 * @param text - the line as printed on screen.
 * @returns the matches in reading order, empty when none reads as a file.
 */
export function findFileLinks(text: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = []
  LINK_PATTERN.lastIndex = 0
  for (let hit = LINK_PATTERN.exec(text); hit !== null; hit = LINK_PATTERN.exec(text)) {
    const cut = hit[0].indexOf(':')
    const path = hit[0].slice(0, cut)
    if (!isFilePathCandidate(path)) continue
    matches.push({ text: hit[0], path, line: Number(hit[0].slice(cut + 1).split(':')[0]), index: hit.index })
  }
  return matches
}

/** Wide East Asian code points occupy two terminal cells. */
const WIDE_CELL = new RegExp(`[${[
  '\\u1100-\\u115f\\u2329\\u232a\\u2e80-\\ua4cf\\uac00-\\ud7a3',
  '\\uf900-\\ufaff\\ufe10-\\ufe19\\ufe30-\\ufe6f\\uff00-\\uff60\\uffe0-\\uffe6',
  '\\u{1f300}-\\u{1f64f}\\u{1f900}-\\u{1f9ff}\\u{20000}-\\u{3fffd}',
].join('')}]`, 'u')

/**
 * Terminal cell columns a string occupies.
 * @param text - the string to measure.
 * @returns its width in cells, with wide code points counted twice.
 */
export function cellColumns(text: string): number {
  let width = 0
  for (const char of text) width += WIDE_CELL.test(char) ? 2 : 1
  return width
}

/**
 * Turn grep-style `path:line` output into links that open the file at that line.
 * @param terminal - the xterm screen to scan.
 * @param callbacks - opening behavior and the terminal's live working directory.
 * @returns the registration disposer.
 */
export function registerTerminalFileLinks(terminal: TerminalLinkHost, callbacks: TerminalFileLinkCallbacks): { dispose(): void } {
  return terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const text = terminal.buffer.active.getLine(y - 1)?.translateToString(true)
      if (text === undefined) { callback(undefined); return }
      const matches = findFileLinks(text)
      if (matches.length === 0) { callback(undefined); return }
      callback(matches.map((match): ILink => {
        const x = cellColumns(text.slice(0, match.index)) + 1
        return {
          range: { start: { x, y }, end: { x: x + cellColumns(match.text) - 1, y } },
          text: match.text,
          activate: () => { callbacks.openFile(match.path, { line: match.line, cwd: callbacks.cwd() }) },
        }
      }))
    },
  })
}
