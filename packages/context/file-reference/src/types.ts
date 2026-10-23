/**
 * Public file-reference discovery records. This module contains types only so
 * generated Remote clients can consume it without Host runtime code.
 * @module @deepseek-ai/dsh-file-reference/types
 */

/** One path-only completion candidate supplied by the target Session's Host. */
export interface FileReferenceCandidate {
  /** Path used to query or drill this candidate; normally relative to Session cwd. */
  path: string
  /**
   * Canonical Host-authorized path inserted when this candidate is selected.
   * Set when `path` is a virtual query path for a mounted or attached root.
   */
  referencePath?: string
  /** Directories keep completion open; files finish the mention. */
  kind: 'file' | 'directory'
}
