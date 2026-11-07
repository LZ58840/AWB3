import { imageRatioMilli } from './rules/aspectRatio';
import { formatDuration } from './rules/rateLimit';
import { repostAgeText } from './rules/repost';
import type { AspectLimits, Failure, PostImage, Ratio } from './types';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const isAre = (count: number) => (count === 1 ? 'is' : 'are');

// A Devvit post id is a fullname (t3_xxx). The links of legacy use the bare id.
const bare = (id: string): string => id.replace(/^t3_/, '');

// D1 (owner decision pending, due 2026-11-13): an image is numbered by its gallery position, `image.n`.
// To revert to legacy numbering, number the failed images 1..k over the whole failure: their index in the failed list, plus 1.
const imageLink = (image: PostImage, detail = ''): string => `[Image #${image.n}${detail}](${image.url})`;

// A limit is written as the legacy Python float: 1.6, 0.429, 2.0.
const limitText = ({ a, b, milli }: Ratio): string =>
  `${a}:${b} (${Number.isInteger(milli / 1000) ? (milli / 1000).toFixed(1) : milli / 1000}:1)`;

function aspectLimitText({ lower, upper }: AspectLimits): string {
  if (lower && upper) return `between ${limitText(lower)} and ${limitText(upper)}`;
  if (lower) return `of or wider than ${limitText(lower)}`;
  return upper ? `of or taller than ${limitText(upper)}` : '';
}

const SOURCE_HELP =
  '\n\n\t- Please make a top level comment crediting the original source artwork/artist.' +
  '\n\n\t\t- Try doing a search for the artwork on [SauceNAO](https://saucenao.com/) or [IQDB](https://iqdb.org/?css=1).' +
  '\n\n\t\t- If you edited this wallpaper, please provide the sources of all artworks used.' +
  '\n\n\t\t- If source is from official media, please cite the episode, chapter, volume, etc.' +
  '\n\n\t- Respect the artist and their work - do not impersonate, steal from, or infringe on the copyright of other artists.';

function section(f: Failure): string {
  switch (f.rule) {
    case 'flair':
      return f.sections
        .map(
          (s) =>
            `\n\n- ${cap(s.orientation)} images are not allowed under the **${f.flair}** flair.` +
            `\n\n\t- ${s.images.map((i) => imageLink(i)).join(', ')} ${isAre(s.images.length)} ${s.orientation}.`,
        )
        .join('');
    case 'resolutionMismatch': {
      const many = f.tagged.length > 1 ? 's' : '';
      const single = f.tagged.length === 1 ? 'es' : '';
      const sizes = (list: { width: number; height: number }[]) => list.map((z) => `${z.width}x${z.height}`).join(', ');
      return (
        `\n\n- **Mismatched resolution${many} in title.** Please ensure the resolution${many} tagged in the title exactly match${single} the resolution${many} of your submitted image${many}.` +
        `\n\n\t- Tagged resolution${many} in title: ${sizes(f.tagged)}` +
        `\n\n\t- Mismatched resolution${many}: ${sizes(f.mismatched)}`
      );
    }
    case 'resolutionBad':
      return (
        '\n\n- **Bad resolution.**' +
        f.sections
          .map(
            (s) =>
              `\n\n\t- ${cap(s.orientation)} images must be at least **${s.min.width}x${s.min.height}**.` +
              `\n\n\t\t- ${s.images.map((i) => imageLink(i, ` (${i.width}x${i.height})`)).join(', ')} ${isAre(s.images.length)} too small.`,
          )
          .join('')
      );
    case 'aspectRatio': {
      const images = (list: PostImage[], why: string) =>
        list.length === 0
          ? ''
          : `\n\n\t\t- ${list.map((i) => imageLink(i, ` (${(imageRatioMilli(i.width, i.height) / 1000).toFixed(3)}:1)`)).join(', ')} ${isAre(list.length)} too ${why}.`;
      return (
        '\n\n- **Bad aspect ratio.**' +
        f.sections
          .map(
            (s) =>
              `\n\n\t- ${cap(s.orientation)} images must have an aspect ratio **${aspectLimitText(s.limits)}**.` +
              images(s.tall, 'tall') +
              images(s.wide, 'wide'),
          )
          .join('')
      );
    }
    case 'rateLimit': {
      const recent = f.recent
        .map((r) => `\n\n\t\t- [${bare(r.id)}](https://redd.it/${bare(r.id)}) (${formatDuration(f.createdAt - r.createdAt)})`)
        .join('');
      const next = new Date(f.nextAt).toISOString().slice(0, 19).replace('T', ' ');
      const deleted = f.countDeleted ? 'Deleted submissions will still be counted towards the rate limit.' : '';
      return (
        '\n\n- **Rate limit reached.**' +
        `\n\n\t- You cannot submit more than **${f.posts} posts in a ${f.hours}-hour period.** You submitted:` +
        recent +
        `\n\n\t- Please wait until **${next} UTC** to submit again. ${deleted}`
      );
    }
    case 'repost':
      return (
        '\n\n- **Repost detected.**' +
        `\n\n\t- Please avoid reposting images submitted in the last ${f.months} month${f.months > 1 ? 's' : ''}.` +
        f.matches
          .map(
            (m) =>
              `\n\n\t\t- [Image #${m.n}](${m.url}) matched submission [${bare(m.matchPostId)}](https://redd.it/${bare(m.matchPostId)})` +
              ` (${repostAgeText(m.matchCreatedAt, f.createdAt)}, [${m.similarity.toFixed(2)}% certainty](${m.matchUrl}))`,
          )
          .join('')
      );
    case 'sourceComment':
      return `\n\n- **Missing source in comments.** Timeout after ${f.hours} hour${f.hours === 1 ? '' : 's'}.${SOURCE_HELP}`;
  }
}

export const REPORT_REASON = 'Submission flagged for manual review (see comment)';

/** The comment of a removal or a report. */
export function renderComment(subreddit: string, failures: Failure[]): string {
  const many = failures.length === 1 ? '' : 's';
  return (
    `Thank you for contributing to r/${subreddit}! Unfortunately, your submission was removed for the following reason${many}:` +
    failures.map(section).join('') +
    `\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](https://reddit.com/message/compose/?to=/r/${subreddit}) if you have any questions or concerns.*`
  );
}
