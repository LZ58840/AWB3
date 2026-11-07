import { describe, expect, it } from 'vitest';
import { decodeGray } from '../../src/core/image/decode';
import { type Gray, prepare, signature, thumbnail, transform, type Variant, variants } from '../../src/core/image/features';
import { compare, type Decision, gate, type GateHit } from '../../src/core/image/match';
import { defaults, fixture } from './helpers';

/** The whole cascade for one new image (the query) against one stored image (the candidate), with the numbers of each stage. */
function cascade(query: Gray | string, candidate: Gray | string): { gate?: GateHit; decision?: Decision; action: Decision['action'] } {
  const load = (x: Gray | string) => (typeof x === 'string' ? prepare(decodeGray(fixture(x))) : x);
  const [q, c] = [load(query), load(candidate)];
  const [hit] = gate(variants(q), [{ id: 'candidate', sig: signature(c) }], defaults.gate);
  if (!hit) return { action: 'none' };
  const decision = compare(thumbnail(q), thumbnail(c), hit.variant, defaults);
  return { gate: hit, decision, action: decision.action };
}

// The labels come from how each pair was built (tools/make_similarity_fixtures.ts), not from the matcher. The numbers of the
// stages show which stage decides, so a pair that should fail at stage 3 does not pass for another reason.
describe('synthetic cascade set (plan 7.4)', () => {
  it('T1: same background, a different 15% character: no match (NCC is too low)', () => {
    const { gate, decision } = cascade('t1-a.jpg', 't1-b.jpg');
    expect(gate!.distance).toBeLessThanOrEqual(defaults.gate);
    expect(decision).toMatchObject({ action: 'none' });
    expect(decision!.ncc).toBeLessThan(defaults.ncc);
  });

  it('T1b: same background, a different 8% character: no match, and only the block rule says so', () => {
    const { gate, decision } = cascade('t1b-a.jpg', 't1b-b.jpg');
    expect(gate!.distance).toBeLessThanOrEqual(defaults.gate);
    expect(decision!.ncc).toBeGreaterThanOrEqual(defaults.ncc); // stage 2 passes
    expect(decision!.matchedPercent).toBeGreaterThanOrEqual(defaults.minTiles); // at most 9 changed tiles
    expect(decision!.largestBlock).toBeGreaterThanOrEqual(4); // a block of 4 tiles is similarity 93.75, under reportAt 94
    expect(decision!.action).toBe('none');
  });

  it('T2: a 2% watermark, recompressed: match', () => {
    const { gate, decision } = cascade('t2-watermark.jpg', 'base-valley.jpg');
    expect(gate!.variant).toBe('identity');
    expect(decision!.action).not.toBe('none');
  });

  it('T3: a 9:19.5 phone crop of the original: match', () => {
    const { gate, decision } = cascade('t3-phone.jpg', 'base-valley.jpg');
    expect(gate!.distance).toBeLessThanOrEqual(defaults.gate);
    expect(decision!.action).not.toBe('none');
  });

  it('T4: mirrored, upscaled, cropped by 4% and letterboxed to 4:3: match, with the mirrored query', () => {
    const { gate, decision } = cascade('t4-mirror-up-crop-letterbox.jpg', 'base-valley.jpg');
    expect(gate!.variant).toBe('mirror');
    expect(decision!.action).not.toBe('none');
  });

  it('T5: two different images with the same palette: no match, rejected by stage 3 (NCC passes)', () => {
    const { gate, decision } = cascade('base-shrine-a.jpg', 'base-shrine-b.jpg');
    expect(gate!.distance).toBeLessThanOrEqual(defaults.gate);
    expect(decision!.ncc).toBeGreaterThanOrEqual(defaults.ncc);
    expect(decision!.matchedPercent).toBeLessThan(defaults.minTiles);
    expect(decision!.largestBlock).toBeGreaterThanOrEqual(4);
    expect(decision!.action).toBe('none');
  });

  it('T6: same background, a different 5% character (it covers at least 2 tiles): never a removal at the defaults', () => {
    const { decision } = cascade('t6-a.jpg', 't6-b.jpg');
    expect(decision!.changedTiles).toBeGreaterThanOrEqual(2);
    expect(decision!.similarity).toBeLessThan(defaults.removeAt);
    expect(decision!.action).not.toBe('remove');
  });
});

describe('edit set: the same picture, edited (plan 7.4)', () => {
  it.each([
    ['recompressed at JPEG quality 60', 'edit-recompress.jpg'],
    ['halved in size (PNG)', 'edit-resize.png'],
    ['brighter and lower in contrast', 'edit-brightness.jpg'],
    ['hue shifted by 17 degrees', 'edit-hue.jpg'],
    ['cropped by 5% at the left and top', 'edit-crop5.jpg'],
    ['cropped by 15% on both axes', 'edit-crop15.jpg'],
  ])('%s: match', (_name, file) => {
    expect(cascade(file, 'base-valley.jpg').action).not.toBe('none');
  });
});

describe('rotated and mirrored reposts', () => {
  it('a JPEG of the picture turned by 90 degrees counter-clockwise (portrait against landscape): match, with the rotation turned back', () => {
    const { gate, decision } = cascade('edit-rotate90.jpg', 'base-valley.jpg');
    expect(gate!.variant).toBe('rot270');
    expect(decision!.action).not.toBe('none');
  });

  // the variant that turns a transformed picture back to the original
  it.each([
    ['identity', 'identity'],
    ['mirror', 'mirror'],
    ['rot90', 'rot270'],
    ['rot270', 'rot90'],
    ['rot90-mirror', 'rot90-mirror'], // a reflection: its own inverse
    ['rot270-mirror', 'rot270-mirror'],
  ] as [Variant, Variant][])('a picture with the transform %s is found with the variant %s', (applied, undone) => {
    const original = prepare(decodeGray(fixture('base-valley.jpg')));
    const { gate, decision } = cascade(prepare(transform(original, applied)), original);
    expect(gate).toMatchObject({ distance: 0, variant: undone });
    expect(decision).toMatchObject({ action: 'remove', similarity: 100 });
  });
});
