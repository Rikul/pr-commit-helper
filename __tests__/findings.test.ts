import { describe, expect, it } from 'vitest';
import { parsePatch, type FileDiff } from '../src/diff';
import { dedupe, extractJson, filterBySeverity, parseReview, placeFindings } from '../src/findings';

const file: FileDiff = {
  path: 'src/a.ts',
  status: 'modified',
  hunks: parsePatch('@@ -10,3 +10,4 @@\n ctx\n+added1\n+added2\n ctx2\n@@ -40,1 +41,2 @@\n x\n+y'),
};
// commentable: 10,11,12,13 and 41,42

const base = { severity: 'high' as const, category: 'bug', title: 'Oops', body: 'b' };

describe('extractJson / parseReview', () => {
  it('handles fenced JSON with surrounding prose', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
  });

  it('drops malformed findings and normalizes severity', () => {
    const r = parseReview(
      JSON.stringify({
        summary: 's',
        findings: [
          { path: 'a', line: '5', severity: 'HIGH', category: 'bug', title: 't', body: 'b' },
          { path: 'a', severity: 'low', title: 'no line' },
          { path: 'a', line: 3, severity: 'weird', category: 'x', title: 't2' },
        ],
      }),
    );
    expect(r.invalid).toBe(1);
    expect(r.findings.map((f) => [f.line, f.severity])).toEqual([
      [5, 'high'],
      [3, 'medium'],
    ]);
  });

  it('throws when there is no JSON', () => {
    expect(() => parseReview('no json here')).toThrow();
  });
});

describe('placeFindings', () => {
  it('keeps findings on commentable lines inline', () => {
    const [p] = placeFindings([{ ...base, path: 'src/a.ts', line: 11, suggestion: 'fix' }], [file]);
    expect(p).toMatchObject({ inline: true, line: 11, suggestion: 'fix' });
  });

  it('snaps nearby lines and drops the suggestion', () => {
    const [p] = placeFindings([{ ...base, path: 'src/a.ts', line: 15, suggestion: 'fix' }], [file]);
    expect(p).toMatchObject({ inline: true, line: 13, suggestion: undefined });
  });

  it('marks far-away lines and unknown files as non-inline', () => {
    const out = placeFindings(
      [
        { ...base, path: 'src/a.ts', line: 30 },
        { ...base, path: 'other.ts', line: 1 },
      ],
      [file],
    );
    expect(out.map((f) => f.inline)).toEqual([false, false]);
  });

  it('drops start_line from another hunk or after line', () => {
    const out = placeFindings(
      [
        { ...base, path: 'src/a.ts', line: 41, start_line: 12 },
        { ...base, path: 'src/a.ts', line: 11, start_line: 12 },
        { ...base, path: 'src/a.ts', line: 12, start_line: 10 },
      ],
      [file],
    );
    expect(out.map((f) => f.start_line)).toEqual([undefined, undefined, 10]);
  });

  it('accepts a leading ./ in paths', () => {
    expect(placeFindings([{ ...base, path: './src/a.ts', line: 11 }], [file])[0]).toMatchObject({
      inline: true,
      path: 'src/a.ts',
    });
  });
});

describe('dedupe / severity', () => {
  it('keeps the most severe duplicate and sorts by severity', () => {
    const placed = placeFindings(
      [
        { ...base, path: 'src/a.ts', line: 11, severity: 'low' },
        { ...base, path: 'src/a.ts', line: 12, severity: 'critical', title: 'OOPS ' },
        { ...base, path: 'src/a.ts', line: 41, severity: 'medium', title: 'Other' },
      ],
      [file],
    );
    const d = dedupe(placed);
    expect(d.map((f) => f.severity)).toEqual(['critical', 'medium']);
    expect(filterBySeverity(d, 'high')).toHaveLength(1);
  });
});
