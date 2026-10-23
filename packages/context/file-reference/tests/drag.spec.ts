import { describe, expect, it } from 'vitest'
import {
  FILE_REFERENCE_DRAG_TYPE, fileReferenceDragText, parseFileReferenceDrag, serializeFileReferenceDrag,
} from '../src/grammar.ts'

describe('workspace file-reference drag payload', () => {
  it('serializes a regular file with any filename and preserves its canonical absolute path', () => {
    const payload = { path: '/home/fate/code/FateDocs/archive.data', kind: 'file' as const }
    const serialized = serializeFileReferenceDrag(payload)
    expect(FILE_REFERENCE_DRAG_TYPE).toBe('application/x-dsh-file-reference')
    expect(serialized).toBe(JSON.stringify({ version: 1, ...payload }))
    expect(parseFileReferenceDrag(serialized!)).toEqual(payload)
    expect(fileReferenceDragText(payload)).toBe('@/home/fate/code/FateDocs/archive.data')
  })

  it('keeps directory semantics in a closed prompt token', () => {
    const payload = { path: '/home/fate/code/Fate Docs', kind: 'directory' as const }
    expect(fileReferenceDragText(payload)).toBe('@"/home/fate/code/Fate Docs/"')
    expect(parseFileReferenceDrag(serializeFileReferenceDrag(payload)!)).toEqual(payload)
  })

  it('rejects malformed or unrepresentable untrusted payloads', () => {
    expect(parseFileReferenceDrag('not-json')).toBeUndefined()
    expect(parseFileReferenceDrag(JSON.stringify({ version: 2, path: '/tmp/a', kind: 'file' }))).toBeUndefined()
    expect(parseFileReferenceDrag(JSON.stringify({ version: 1, path: '/tmp/a', kind: 'device' }))).toBeUndefined()
    expect(parseFileReferenceDrag(JSON.stringify({ version: 1, path: 'relative/file', kind: 'file' }))).toBeUndefined()
    expect(parseFileReferenceDrag('x'.repeat(32_769))).toBeUndefined()
    expect(serializeFileReferenceDrag({ path: 'relative/file', kind: 'file' })).toBeUndefined()
    expect(serializeFileReferenceDrag({ path: '/tmp/unsafe"path', kind: 'file' })).toBeUndefined()
    expect(serializeFileReferenceDrag({ path: '/tmp/control\npath', kind: 'file' })).toBeUndefined()
  })
})
