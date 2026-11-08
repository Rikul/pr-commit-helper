import { describe, expect, it } from 'vitest';
import { commentTrigger, isCommand } from '../src/trigger';

const opts = { command: '/review', allowed: ['OWNER', 'MEMBER'] };
const payload = (over: Record<string, unknown> = {}, comment: Record<string, unknown> = {}) => ({
  action: 'created',
  issue: { number: 7, pull_request: { url: 'x' } },
  comment: { id: 99, body: '/review', author_association: 'OWNER', user: { login: 'rikul', type: 'User' }, ...comment },
  ...over,
});

describe('isCommand', () => {
  it('matches the command on the first line only', () => {
    expect(isCommand('/review', '/review')).toBe(true);
    expect(isCommand('  /Review please\nthanks', '/review')).toBe(true);
    expect(isCommand('/reviewer', '/review')).toBe(false);
    expect(isCommand('please /review', '/review')).toBe(false);
    expect(isCommand('looks good\n/review', '/review')).toBe(false);
  });
});

describe('commentTrigger', () => {
  it('reviews when an owner or member comments the command on a PR', () => {
    expect(commentTrigger(payload(), opts)).toEqual({ kind: 'review', pullNumber: 7, commentId: 99 });
    expect(commentTrigger(payload({}, { author_association: 'member' }), opts).kind).toBe('review');
  });

  it('refuses other commenters', () => {
    for (const a of ['COLLABORATOR', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
      const t = commentTrigger(payload({}, { author_association: a }), opts);
      expect(t.kind).toBe('denied');
    }
    expect(commentTrigger(payload({}, { author_association: 'COLLABORATOR' }), { ...opts, allowed: ['COLLABORATOR'] }).kind).toBe(
      'review',
    );
  });

  it('ignores edits, issues, other comments and bots', () => {
    expect(commentTrigger(payload({ action: 'edited' }), opts).kind).toBe('ignore');
    expect(commentTrigger(payload({ issue: { number: 7 } }), opts).kind).toBe('ignore');
    expect(commentTrigger(payload({}, { body: 'nice work' }), opts).kind).toBe('ignore');
    expect(commentTrigger(payload({}, { user: { login: 'x[bot]', type: 'Bot' } }), opts).kind).toBe('ignore');
  });
});
