![](https://raw.githubusercontent.com/LZ58840/AnimewallpaperBot/main/banner.png)
# AnimewallpaperBot v3.0
A specialized moderation app for /r/Animewallpaper and /r/AnimePhoneWallpapers. It replaces the legacy AnimewallpaperBot (v2.7.0) and runs on the Reddit Developer Platform (Devvit) as `animewallpaperbotv3`.

- [Terms of Use](https://www.reddit.com/r/Animewallpaper/wiki/awb-terms)
- [Privacy Policy](https://www.reddit.com/r/Animewallpaper/wiki/awb-privacy)

Version 3.0 makes no external HTTP requests. Version 3.0 has no repost check. Version 3.1 adds it.

## Features
- Flair Rules (`flairRules`)
- Mismatched Resolution Detection (`resolutionMismatch`)
- Resolution Thresholds (`resolutionBad`)
- Aspect Ratio Thresholds (`aspectRatio`)
- Rate Limiting (`rateLimit`)
- Source Comment Detection (`sourceComment`)
- Repost Detection (version 3.1)

A moderator turns on each rule in the install settings. All rules are off by default.

| Rule | What AWB3 does |
|---|---|
| Flair Rules | For a flair with a list of orientations, removes a post that has an image of a different orientation. A post with a `skip` flair is not checked. |
| Mismatched Resolution | Removes a post when the title has a size tag, for example [1920x1080], and an image has a size that no tag lists. |
| Resolution Thresholds | Removes a post when an image is smaller than the minimum size for its orientation. |
| Aspect Ratio Thresholds | Removes a post when an image is too tall or too wide for its orientation. AWB3 does not check square images. |
| Rate Limiting | Removes a post when its author already made the allowed number of posts in the time window. |
| Source Comment | Removes a post when its author wrote no top-level comment before the deadline. |

When a post breaks a rule and the mode is **Enforce**, AWB3:
1. writes a comment that gives the reasons;
2. marks the comment as a moderator comment and pins it;
3. locks the post;
4. removes the post. It does not mark the post as spam.

The comment text follows the templates of the legacy bot. This is the comment for one image that is too small:

```markdown
Thank you for contributing to r/Animewallpaper! Unfortunately, your submission was removed for the following reason:

- **Bad resolution.**

	- Horizontal images must be at least **1920x1080**.

		- [Image #1 (1600x1200)](https://i.redd.it/abc123.png) is too small.

*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](https://reddit.com/message/compose/?to=/r/Animewallpaper) if you have any questions or concerns.*
```

Notes on the checks:
- AWB3 checks only images that Reddit hosts, in PNG or JPEG format. For a crosspost, it checks the images of the original post.
- If Reddit did not finish an image, AWB3 waits. After about 16 minutes, it checks the post with the images that are ready.
- The rate limit rule and the source comment rule apply to every post, with or without an image.
- AWB3 checks a post that AutoModerator holds for review.
- AWB3 does not ban users. Version 3.0 does not report posts.

AWB3 does not check these posts:
- a post that a moderator approved;
- a post that a moderator or Reddit removed;
- a post that its author deleted, and a post of a deleted account;
- a post of the app account;
- a post of an exempt author;
- a post with a `skip` flair.

## Quick Start Guide
1. Open the [app directory](https://developers.reddit.com/apps). Select `animewallpaperbotv3`.
2. Select **Install**. Select your subreddit. You must be a moderator of it.
3. Open the install settings of the app. The **Mode** is **Off**. In this mode AWB3 does nothing.
4. Turn on the rules that you want. Set their values. See [Settings](#settings).
5. Set **Mode** to **Dry run**. AWB3 checks new posts and takes no action.
6. Wait for new posts. Select **AWB: status** in the three-dot menu of the subreddit. Read the decisions and the rules.
7. Select **AWB: explain** in the three-dot menu of a post. Read why AWB3 acted or did not act.
8. If the legacy bot runs next to AWB3, select **AWB: shadow report**. Compare the decisions of the two bots.
9. When the decisions are right, set **Mode** to **Enforce**.

A higher mode applies only to posts that AWB3 sees for the first time after the change. A lower mode applies to all posts at once. See [Modes](#modes).

## Settings
Moderators edit these install settings. The install settings page rejects a value that is not valid. AWB3 reads the settings every minute.

| Label (key) | Default | Value |
|---|---|---|
| Mode (`mode`) | Off | Off, Dry run, or Enforce. |
| Exempt authors (`exceptAuthors`) | empty | User names, separated by commas, without `u/`. AWB3 does not start a check for posts of these authors. A source check that is already in the queue still runs. The match is exact. |
| Flair rules (`flairRules`) | empty | One rule on each line: `Flair: value`. The value is `skip`, or a list of `horizontal`, `vertical`, and `square` that the flair allows. A flair that is not in the list gets no flair check. |
| Check the size tags in the title (`resolutionMismatch`) | off | On or off. |
| Check the minimum size (`resolutionBad`) | off | On or off. Set at least one minimum size. |
| Minimum size of horizontal images (`minHorizontal`) | empty | Width x height, for example `1920x1080`. Empty means no minimum. |
| Minimum size of vertical images (`minVertical`) | empty | The same format, for example `900x1600`. |
| Minimum size of square images (`minSquare`) | empty | The same format, for example `1000x1000`. |
| Check the aspect ratio (`aspectRatio`) | off | On or off. Set at least one limit. |
| Aspect ratio limits of horizontal images (`aspectHorizontal`) | empty | `A:B to C:D`. A:B is the smallest ratio of width to height. C:D is the largest. Write `none` for no limit on one side, for example `16:10 to none`. |
| Aspect ratio limits of vertical images (`aspectVertical`) | empty | The same format, for example `9:21 to 10:16`. |
| Limit the posts of each author (`rateLimit`) | off | On or off. |
| Rate limit window (hours) (`rateLimitHours`) | 24 | A whole number from 1 to 720. |
| Posts allowed in the window (`rateLimitPosts`) | 4 | A whole number from 1 to 1000. AWB3 removes the next post of the author. |
| Count deleted posts (`rateLimitCountDeleted`) | off | On or off. When on, deleted posts count toward the limit. |
| Require a source comment (`sourceComment`) | off | On or off. |
| Hours to write the source comment (`sourceHours`) | 1 | A number from 0.01 to 696. The hours start at the creation time of the post. |

- A rule with a switch is on only when the switch is on and its values are complete. If not, AWB3 keeps that rule off and sends the alert `config`.
- If **Exempt authors** or **Flair rules** has an error, AWB3 sets the mode to Off. A lost exemption must not cause a removal.

## Modes
- `off` - AWB3 does not check, comment, pin, lock, or remove. It writes no audit entry and no rate-limit record for a post. It keeps a status record for each post. Errors still go to the log. The alerts still work.
- `dry-run` - AWB3 checks each post and writes the result to its audit log. The result is "would remove" or "no action". AWB3 does not comment, pin, lock, or remove.
- `enforce` - AWB3 comments, pins, locks, and removes a post that breaks a rule.

Each post has one mode. It is the lower of two modes: the mode at the first look of AWB3 at the post, and the current mode. The order, from lowest to highest, is Off, Dry run, Enforce.
- A post that AWB3 first saw in Dry run is not removed after you set Enforce.
- A post that AWB3 first saw in Off is not checked later.
- When you set a lower mode, it applies to all posts at once.
- In Dry run, AWB3 checks a post that AnimewallpaperBot removed. In Enforce, AWB3 skips such a post.

## Menu Items
Only moderators see these items.
- `AWB: status` (subreddit menu) - the mode, the time of the last tick, the queue, the errors in a row, and the last error. The p95 time from submit to action (95% of the actions took this time or less). The decisions of today and of the last 7 days (remove, would remove, no action), and the rules of the removals.
- `AWB: explain` (post menu) - the status of the post, its first mode, and its creation time. For each check: the action, the rules, the counters, and the steps done. If AWB3 has no record of the post, it says so.
- `AWB: shadow report` (subreddit menu) - a form asks for 1 to 7 days (default 7). The report compares AWB3 with the legacy bot: posts compared, agreement, removals that only one bot made, agreement for each rule, and the p95 time.

The shadow report reads the mod log for actions of the user AnimewallpaperBot. It has no legacy actions to compare when the legacy bot does not run. It leaves out a post when a known difference explains the result, for example a repost action of the legacy bot.

## Alerts
AWB3 sends each alert as a mod notification in modmail. The subject has the form `AWB: <reason>`. AWB3 sends at most 1 alert for each reason in 6 hours.
- `config` - a rule is on, but its settings are not valid or not complete. The alert lists them. Correct the listed settings.
- `errors` - AWB3 stopped work on a post after repeated errors. Select **AWB: explain** on the post. Check the post by hand.
- `tick-stalled` - no tick ended in the last 5 minutes, or none ended since the install. AWB3 checks no post. Check new posts by hand.
- `queue-stalled` - the oldest item in the queue is more than 10 minutes late. Select **AWB: status** to see the queue. AWB3 checks posts more slowly than they arrive.
- `audit-mismatch` - the mod log and the audit log do not agree on the removals of the last 24 hours. Compare the post IDs in the alert with the mod log.
- `no-images` - a post looks like a Reddit image post, but AWB3 found no usable image. AWB3 cannot check the images of this post. Check the post by hand.

If the same alert repeats, contact the author. See [Contact](#contact).

## How It Works
- Permissions: Reddit API (moderator scope) and Redis. No HTTP permission. The app account does all actions. No action runs as a user.
- Reddit API: AWB3 reads posts, comments, the list of new posts, the mod queue, and the mod log. It writes comments, pins, locks, removals, and mod notifications.
- `onPostSubmit` - adds the new post to the queue in Redis and writes the rate-limit record of the author, unless the mode is Off.
- `onPostFlairUpdate` - adds a skipped post that is less than 48 hours old.
- `tick` - runs every minute. Checks the posts in the queue, at most 5 in one run.
- `sweep` - runs every 5 minutes. Reads the 100 newest posts and the mod queue. Adds the posts that are less than 48 hours old and that AWB3 did not see.
- `health` - runs every 15 minutes. Sends alerts. Writes one summary of the shadow report each day, when the mode is not Off.

## Data
Each installation has its own storage in Redis. Redis holds no post titles, no post bodies, and no URLs. AWB3 keeps the user ID of an author only in the rate-limit record. Version 3.0 does not download images. It stores no image data.

| Data | What it holds | How long |
|---|---|---|
| Post record | The status, the first mode, and the creation time of a post. The rules that failed and the action. The ID of the comment that AWB3 wrote. The steps done and the error counts. | 30 days after the last write |
| Audit log | One entry for each decision, skip, image wait that timed out, and error. An entry has the post ID, the rules, the action, the mode, the reason, and the time. One daily summary of the shadow report. | 30 days after the last entry of the day |
| Rate-limit record | The user ID of an author, and the IDs and creation times of the recent posts of the author. | The rate limit window (24 hours by default, 720 hours at most) |
| Queue | The IDs of the posts that wait for a check, and their due times. | Until AWB3 finishes the work |
| Tick lock | One lock value. | 45 seconds |
| App status | The time of the last tick. The error count and the last error. The ID of the app account. The time of the last alert for each reason. The day of the last summary. | No expiry |
| Install settings | The values that moderators enter. Devvit stores them. | Until moderators change them or uninstall the app |
| App logs | One JSON line for each decision, skip, and error: the event, the subreddit, the post ID, the mode, the rules, the action, and the duration in milliseconds. An error line has the error text and the stack trace. Devvit stores the logs. | Up to 7 days (see PRIVACY.md) |

## Stop or Roll Back
- Set **Mode** to **Off**. AWB3 reads the settings every minute. Then it makes no new check and no new action. AWB3 finishes a removal that it already started.
- To undo a removal, approve the post. AWB3 does not act on an approved post. AWB3 does not delete its comment and does not unlock the post. Delete the comment and unlock the post by hand, if you want.
- To remove the app, uninstall it. Devvit deletes the data and the settings of the installation. You cannot recover them.

## Changes from v2.7.0
- AWB3 has no repost check in version 3.0.
- AWB3 reads install settings. The legacy bot read the wiki page `awb`. The install settings page rejects a bad value. A rule with a bad setting is off, and AWB3 sends the alert `config`. The legacy bot stopped all moderation without a message.
- AWB3 numbers the images in a comment by their position in the gallery. The legacy bot numbered only the images that failed.
- The rate limit counts only the posts that the author made before the post under check. A removed post does not count. The legacy bot also counted later posts and the posts that it removed itself.
- The source check runs once, at the deadline. The removal can come about 2 minutes later. The legacy bot checked every minute until the deadline.
- AWB3 checks only images that Reddit hosts. The legacy bot also checked images on other hosts.
- AWB3 checks a skipped post again only when its flair changes in the first 48 hours. The legacy bot checked skipped posts again for 48 hours.

## Development
Requirements: Node.js 22 or later. Run `npm ci` first.
- `npm test` - run all tests (vitest).
- `npm run typecheck` - run `tsc --noEmit`.
- `npm run lint` - run the rule "no module state" (`test/lint`).
- `npm run build` - bundle `src/server/index.ts` to `dist/server/index.cjs`.
- `heph run ci //...` - typecheck and all tests, with a cache. For the Python tests in `tools/`, it also needs the venv: `python3 -m venv tools/.venv && tools/.venv/bin/pip install -r tools/requirements.txt`.
- `npx devvit playtest <test-subreddit>` - run the app on a test subreddit. It needs a login (`npx devvit login`). The test subreddit must have fewer than 200 members.

`src/core` has the pure TypeScript for the rules, the settings, and the comment text. It has no Devvit imports. `src/server` has the Devvit parts: triggers, jobs, menus, alerts, and Redis.

## Testing
The tests run against a simulated Reddit in `test/sim`. It simulates posts, comments, the mod log, mod mail, Redis, and the clock. The default tests call no real Reddit API. No test has a manual step.
- A pull request must add a test that fails without the change (CI check `red-first`). The label `no-behavior` skips this check.
- CI (`.github/workflows/app.yml`) runs lint, typecheck, and the tests on Node.js 22 and 24. It requires 90% coverage of `src/core`.

## Contact
Send a modmail to the moderators of [r/Animewallpaper](https://reddit.com/message/compose/?to=/r/Animewallpaper) or [r/AnimePhoneWallpapers](https://reddit.com/message/compose/?to=/r/AnimePhoneWallpapers). The author of AWB3 is the Reddit user u/LZ58840. The terms and the privacy policy are in `TERMS.md` and `PRIVACY.md`.

## Credits
- Profile picture: [source artwork by るびぃ on pixiv](https://www.pixiv.net/en/artworks/33861959)
- Banner: [source image from the Fandom wiki](https://toarumajutsunoindex.fandom.com/wiki/Electron_(NV)_Goggles?file=Goggles.PNG), [source font](https://www.dafont.com/elementalend.font)
