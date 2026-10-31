/**
 * Browser-safe `@file` token grammar shared by terminal and web clients.
 *
 * @module @deepseek-ai/dsh-file-reference/grammar
 */

import type { FileReferenceCandidate } from './types.ts'

/** Active `@` token ending at the editor cursor. */
export interface ActiveAtToken {
  /** Complete token replaced when the user accepts a completion. */
  prefix: string
  /** Path query after `@` or `@"`. */
  query: string
  /** Whether the user opened a quoted path. */
  quoted: boolean
}

/**
 * Extract an `@path` or `@"path with spaces` token at the cursor. An `@`
 * inside another token, such as an email address, is not a completion trigger.
 * @param line - current editor line.
 * @param cursorCol - cursor column within that line.
 * @returns the active token, or `undefined` outside an `@` token.
 */
export function activeAtToken(line: string, cursorCol: number): ActiveAtToken | undefined {
  const beforeCursor = line.slice(0, cursorCol)
  const quoted = /(?:^|\s)(@"([^"]*))$/u.exec(beforeCursor)
  if (quoted?.[1] !== undefined && quoted[2] !== undefined) {
    return { prefix: quoted[1], query: quoted[2], quoted: true }
  }
  const plain = /(?:^|\s)(@([^\s]*))$/u.exec(beforeCursor)
  if (plain?.[1] === undefined || plain[2] === undefined) return undefined
  return { prefix: plain[1], query: plain[2], quoted: false }
}

/**
 * Format a selected path as prompt text. Whitespace uses the quoted
 * `@"path"` grammar; a quoted directory keeps that quote open after its
 * trailing slash so completion can descend another level.
 * @param candidate - selected file or directory.
 * @param preserveQuote - retain an explicitly opened quote even when unnecessary.
 * @returns the insertion value, or `undefined` for a path the editor grammar cannot represent safely.
 */
export function formatFileMention(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
): string | undefined {
  const selectedPath = candidate.referencePath ?? candidate.path
  const path = candidate.kind === 'directory' ? `${selectedPath}/` : selectedPath
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  const quoted = preserveQuote || /\s/u.test(path)
  if (!quoted) return `@${path}`
  if (candidate.kind === 'directory') return `@"${path}`
  return `@"${path}"`
}

/** Private DataTransfer MIME type for DSH workspace file references. */
export const FILE_REFERENCE_DRAG_TYPE = 'application/x-dsh-file-reference'

/** One workspace path carried by a Files-tree drag; Host still authorizes it. */
export interface FileReferenceDragPayload {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

interface SerializedFileReferenceDragPayload extends FileReferenceDragPayload {
  readonly version: 1
}

function absoluteDragPath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path)
}

function dragMentionPath(payload: FileReferenceDragPayload): string {
  if (payload.kind !== 'directory') return payload.path
  return /[\\/]$/u.test(payload.path) ? payload.path : `${payload.path}/`
}

/** Plain-text fallback used by non-DSH drop targets. */
export function fileReferenceDragText(payload: FileReferenceDragPayload): string | undefined {
  // Keep directory tokens closed on drop; their trailing slash retains folder semantics.
  return formatFileMention({ path: dragMentionPath(payload), kind: 'file' }, false)
}

/** Serialize only paths representable by the safe prompt grammar. */
export function serializeFileReferenceDrag(payload: FileReferenceDragPayload): string | undefined {
  if (!absoluteDragPath(payload.path) || fileReferenceDragText(payload) === undefined) return undefined
  const value: SerializedFileReferenceDragPayload = { version: 1, path: payload.path, kind: payload.kind }
  return JSON.stringify(value)
}

/** Parse and validate an untrusted DataTransfer payload. */
export function parseFileReferenceDrag(value: string): FileReferenceDragPayload | undefined {
  if (value === '' || value.length > 32_768) return undefined
  try {
    const candidate: unknown = JSON.parse(value)
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const record = candidate as Record<string, unknown>
    if (record.version !== 1 || typeof record.path !== 'string' || !absoluteDragPath(record.path)) return undefined
    if (record.kind !== 'file' && record.kind !== 'directory') return undefined
    const payload: FileReferenceDragPayload = { path: record.path, kind: record.kind }
    return fileReferenceDragText(payload) === undefined ? undefined : payload
  } catch {
    return undefined
  }
}
