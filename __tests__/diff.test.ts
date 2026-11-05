import { describe, expect, it } from 'vitest';
import { chunkDiff, commentableLines, type FileDiff, hunkIndexOf, parsePatch, renderHunk } from '../src/diff';

const PATCH = [
  '@@ -1,4 +1,5 @@',
  ' import x',
  '-const a = 1;',
  '+const a = 2;',
  '+const b = 3;',
  ' ',
  ' export {}',
  '\\ No newline at end of file',
  '@@ -20,2 +21,3 @@ function f() {',
  '   return 1;',
  '+  // added',
  ' }',
].join('\n');

describe('parsePatch', () => {
  it('assigns new-file line numbers across hunks', () => {
    const hunks = parsePatch(PATCH);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines.map((l) => [l.kind, l.newLine])).toEqual([
      ['ctx', 1],
      ['del', undefined],
      ['add', 2],
      ['add', 3],
      ['ctx', 4],
      ['ctx', 5],
    ]);
    expect(hunks[1]!.lines.map((l) => l.newLine)).toEqual([21, 22, 23]);
  });

  it('ignores trailing newline and no-newline markers', () => {
    const hunks = parsePatch('@@ -0,0 +1,2 @@\n+a\n+b\n');
    expect(hunks[0]!.lines).toHaveLength(2);
  });

  it('renders line numbers, leaving deleted lines blank', () => {
    const out = renderHunk(parsePatch(PATCH)[0]!);
    expect(out).toContain('    2 + const a = 2;');
    expect(out).toContain('      - const a = 1;');
  });
});

describe('commentable lines', () => {
  const file: FileDiff = { path: 'a.ts', status: 'modified', hunks: parsePatch(PATCH) };
  it('includes added and context lines only', () => {
    expect([...commentableLines(file)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 21, 22, 23]);
    expect(hunkIndexOf(file, 22)).toBe(1);
    expect(hunkIndexOf(file, 10)).toBe(-1);
  });
});

describe('chunkDiff', () => {
  const mk = (path: string, n: number): FileDiff => ({
    path,
    status: 'added',
    hunks: parsePatch(`@@ -0,0 +1,${n} @@\n` + Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n')),
  });

  it('keeps small diffs in one chunk', () => {
    expect(chunkDiff([mk('a', 3), mk('b', 3)], 10_000)).toHaveLength(1);
  });

  it('splits across files when over budget', () => {
    const chunks = chunkDiff([mk('a', 50), mk('b', 50)], 1200);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('### File: a');
    expect(chunks[1]).toContain('### File: b');
  });

  it('splits one big file by hunk', () => {
    const f: FileDiff = { path: 'big', status: 'modified', hunks: [...mk('x', 40).hunks, ...mk('y', 40).hunks] };
    const chunks = chunkDiff([f], 900);
    expect(chunks.length).toBe(2);
    expect(chunks.every((c) => c.includes('### File: big [modified] (partial)'))).toBe(true);
  });
});
