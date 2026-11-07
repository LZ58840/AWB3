import { describe, expect, it } from 'vitest';
import { checkSource } from '../../src/core/rules/sourceComment';

// Legacy L§1.6: ANY top-level comment by the post author passes; the text is not checked. D9: the author of a
// comment can be a deleted account ("[deleted]"); this must not crash the check and is not the post author.
describe('checkSource', () => {
  it('passes when the post author made a top-level comment', () => {
    expect(checkSource(1, 'Artist', ['Someone', 'Artist'])).toBeUndefined();
  });

  it('fails with the timeout when no top-level comment is by the post author', () => {
    expect(checkSource(1, 'Artist', ['Someone', 'Other'])).toEqual({ rule: 'sourceComment', hours: 1 });
    expect(checkSource(0.5, 'Artist', [])).toEqual({ rule: 'sourceComment', hours: 0.5 });
  });

  it('compares the names exactly', () => {
    expect(checkSource(1, 'Artist', ['artist'])).not.toBeUndefined();
  });

  it('ignores a comment of a deleted account (D9)', () => {
    expect(checkSource(1, 'Artist', ['[deleted]', 'Someone'])).not.toBeUndefined();
    expect(checkSource(1, '[deleted]', ['[deleted]'])).not.toBeUndefined();
  });
});
