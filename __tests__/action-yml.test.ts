import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// GitHub evaluates ${{ }} anywhere in action.yml, including descriptions, and
// only a few contexts (like github) are allowed. One stray expression makes the
// whole action fail to load, so only input defaults may contain one.
describe('action.yml', () => {
  const lines = readFileSync(new URL('../action.yml', import.meta.url), 'utf8').split('\n');

  it('uses ${{ }} only in input defaults', () => {
    const offending = lines
      .map((text, i) => ({ text, line: i + 1 }))
      .filter(({ text }) => text.includes('${{') && !/^\s*default:/.test(text));
    expect(offending).toEqual([]);
  });

  it('never references secrets', () => {
    expect(lines.filter((l) => /\$\{\{\s*secrets\./.test(l))).toEqual([]);
  });
});
