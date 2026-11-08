import { describe, expect, it } from 'vitest';
import { loadConfig, splitList } from '../src/config';

const reader = (values: Record<string, string>) => (name: string) => values[name] ?? '';

describe('loadConfig', () => {
  it('applies defaults for anthropic', () => {
    const c = loadConfig(reader({ api_key: 'k', github_token: 't' }));
    expect(c).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      effort: 'medium',
      maxTokens: 32000,
      minSeverity: 'low',
      reviewEvent: 'COMMENT',
      failOnSeverity: 'none',
      skipDraft: true,
      dryRun: false,
      anthropicFallback: true,
      reviewCommand: '/review',
      allowedCommenters: ['OWNER', 'MEMBER'],
    });
    expect(c.exclude).toContain('**/package-lock.json');
  });

  it('requires a model for openai and gemini', () => {
    expect(() => loadConfig(reader({ api_key: 'k', provider: 'openai' }))).toThrow(/model/);
    expect(() => loadConfig(reader({ api_key: 'k', provider: 'gemini' }))).toThrow(/model/);
    expect(loadConfig(reader({ api_key: 'k', provider: 'OpenAI', model: 'm' })).provider).toBe('openai');
  });

  it('parses the review command settings', () => {
    const c = loadConfig(reader({ api_key: 'k', review_command: '/ai-review', allowed_commenters: 'owner, collaborator' }));
    expect(c.reviewCommand).toBe('/ai-review');
    expect(c.allowedCommenters).toEqual(['OWNER', 'COLLABORATOR']);
    expect(() => loadConfig(reader({ api_key: 'k', review_command: '/two words' }))).toThrow(/review_command/);
  });

  it('rejects bad values', () => {
    expect(() => loadConfig(reader({}))).toThrow(/api_key/);
    expect(() => loadConfig(reader({ api_key: 'k', effort: 'extreme' }))).toThrow(/effort/);
    expect(() => loadConfig(reader({ api_key: 'k', max_files: '-1' }))).toThrow(/max_files/);
    expect(() => loadConfig(reader({ api_key: 'k', temperature: '5' }))).toThrow(/temperature/);
    expect(() => loadConfig(reader({ api_key: 'k', review_event: 'APPROVE' }))).toThrow(/review_event/);
  });

  it('parses lists and flags', () => {
    const c = loadConfig(
      reader({ api_key: 'k', include: 'src/**, lib/**\n*.py', exclude: 'gen/**', dry_run: 'true', pr_number: '7' }),
    );
    expect(c.include).toEqual(['src/**', 'lib/**', '*.py']);
    expect(c.exclude.at(-1)).toBe('gen/**');
    expect(c.dryRun).toBe(true);
    expect(c.prNumber).toBe(7);
  });
});

describe('splitList', () => {
  it('splits on commas and newlines', () => {
    expect(splitList(' a, b\n\nc ')).toEqual(['a', 'b', 'c']);
  });
});
