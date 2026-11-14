// The release check of the replay (plan 12 AC3, 7.6). It fails unless the real corpora are in test/fixtures and big enough
// (legacy-corpus-animewallpaper.json: 200 posts; legacy-corpus-animephonewallpapers.json: 10 posts until OD11 is decided), each with its
// legacy-config-<name>.yaml, and both replays equal the legacy decisions and comments, except the approved D-codes (replay.ts).
// A file that is missing is a failure, not a skip. Run it before a release (the default run uses the sample corpus only):
//   npm run test:release
import { expect } from 'vitest';
import { test } from '../flows/helpers';
import { corpusNames, corpusProblems, digest, KNOWN_UNKNOWN, loadCorpus, RELEASE_CORPORA, replay, tally } from './replay';

const present = corpusNames();

test('the real corpora are there and big enough', () => {
  const sizes = Object.fromEntries(Object.keys(RELEASE_CORPORA).map((name) => [name, present.includes(name) ? loadCorpus(name).corpus.posts.length : undefined]));
  expect(corpusProblems(sizes)).toEqual([]);
});

for (const name of Object.keys(RELEASE_CORPORA)) {
  test(`replay of the real corpus "${name}": every decision and comment equals the legacy one, except the approved D-codes; the posts it cannot compare are the known ones`, async (fx) => {
    const { corpus, settings } = loadCorpus(name); // a missing file throws: the check fails
    const outcomes = await replay(fx, corpus, settings);
    process.stderr.write(`release ${name}: ${corpus.posts.length} posts; ${JSON.stringify(tally(outcomes))}; digest ${digest(outcomes)}\n`);
    expect(outcomes.filter(({ verdict }) => verdict === 'differs').map(({ id, legacy, awb }) => ({ id, legacy, awb }))).toEqual([]);
    expect(outcomes.filter(({ verdict }) => verdict === 'unknown').map(({ id }) => id), 'posts that the replay cannot compare (KNOWN_UNKNOWN)').toEqual(KNOWN_UNKNOWN[name]);
  });
}
