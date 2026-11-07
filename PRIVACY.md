# AWB3 Privacy Policy

Last updated: 2026-11-07

This policy says what data the AWB3 app handles. AWB3 is a moderation app. It runs on Reddit's Developer Platform (Devvit). The moderators of r/Animewallpaper and r/AnimePhoneWallpapers installed it.

This policy covers the app only. Read the [Terms of Use](TERMS.md) for the other rules.

## Summary

- The app stores its data in Reddit's storage for Devvit apps (Redis). Each subreddit has its own storage.
- The app sends no data outside Reddit. It uses no external server.
- The app has no ads. It does not sell data. It does not give data to third parties.
- The app stores no post titles, no post bodies, and no URLs in Redis.
- From version 3.1, the app stores image hashes and small gray thumbnails. It does not keep the full images.
- The app deletes the hashes and the thumbnail of a post when the post is deleted.

## What the app reads

The app reads data about posts through the Reddit API. It uses this data only to apply the rules of the moderators and to show the moderators what it did.

- The post ID, the creation time, the title, and the flair.
- The author of the post: the user ID and the username.
- The image links and the image sizes.
- The status of the post: removed, approved, or deleted.
- The top-level comments of a post, to find a comment from the author.
- The mod log of the subreddit, to check the actions of the app and of the older bot AnimewallpaperBot.

From version 3.1, the app also downloads images. See "What the app fetches".

The app stores only the data that the next section lists.

## What the app stores

Reddit runs the storage of each installation. Each Redis value has an expiry time, except the work queue and the app status.

| Data | What it holds | Why | How long |
|---|---|---|---|
| Decision records | One entry for each decision, action, or error. An entry holds the post ID, the rule, the numbers behind the result, the action, and the time. The app also stores daily summary numbers. | To show the moderators why the app acted. To find errors. | 30 days |
| Post records | The status of a post, its creation time, and the result of each rule. The IDs of matched older posts. The ID of the comment that the app wrote. | To avoid a second action on the same post. | 30 days |
| Rate-limit records | The user ID of a post author. The IDs and creation times of the recent posts of that author. | To count the posts of an author for the rate limit rule. | The rate-limit window that the moderators set. The default is 24 hours. The maximum is 30 days. |
| Lists of image posts | The IDs and creation times of image posts. | To build the repost history for older posts. | `repostMonths` plus 1 month (7 months with the default) |
| Image hashes (3.1 and later) | See "Image hashes and thumbnails". | To find reposts. | `repostMonths` months from the creation time of the post, plus a margin of up to 3 weeks |
| Thumbnails (3.1 and later) | See "Image hashes and thumbnails". | To confirm a possible repost. | 30 days from the creation time of the post |
| Delete records (3.1 and later) | The post ID, the time of the deletion, and who deleted the post: the author or someone else. | To make sure that a late job does not store data of a deleted post. | 1 day after a removal. `repostMonths` plus 1 month after a deletion by the author. |
| Work queue | The IDs of posts that wait for a check. | To run the checks in order. | Until the app finishes the work |
| App status | The time of the last run, error counts, the last error, alert times, and locks. | To find faults and to alert the moderators. | No expiry |
| Settings | The values that the moderators enter. This includes the list of usernames that the app skips (`exceptAuthors`). Devvit stores the settings. | To apply the rules that the moderators chose. | Until the moderators change them or uninstall the app |
| App logs | One line for each unit of work. A line holds the event name, the subreddit, the post ID, and the kind of work. It also holds the mode, the rule results, the action, the similarity percentage, and the processing time. An error line also has the error text and a stack trace. Devvit stores the logs. | To find faults. | Up to 7 days |

The app stores no post titles, no post bodies, and no URLs in Redis.

The app stores the user ID of a post author in one place only: the rate-limit record.

## Image hashes and thumbnails

This section applies to version 3.1 and later. The repost check must compare a new image with earlier images. For this, the app stores two kinds of data.

**Hashes.** A hash is a short code of 64 bits. It describes how an image looks. A hash is too short to hold an image. You cannot rebuild an image from a hash.

For a wide image, the app stores 18 more hashes. Each one describes a part of the image that a phone screen can show. The app also stores the image width and height, the creation time of the post, and a few flags.

The moderators set how long the app keeps hashes. The setting is `repostMonths`. The range is 1 to 8 months. The default is 6 months. The time counts from the creation time of the post. The app adds a margin of up to 3 weeks.

The app keeps hashes this long because the repost check must find the repost of an old image.

**Thumbnails.** A thumbnail is a small gray picture of an image. Its long side is 128 pixels. The app uses it to confirm a possible repost.

The app keeps a thumbnail for 30 days from the creation time of the post. The app stores no thumbnail for a post that is older than 30 days.

## What the app fetches

To fetch means to download a file from a host.

Version 3.0 fetches nothing.

From version 3.1, the app fetches images from two hosts only: `i.redd.it` and `preview.redd.it`. Both hosts belong to Reddit.

The app fetches an image only to compute the hashes and the thumbnail for the repost check. The request holds the image address. It holds no user data.

The app does not keep the downloaded image. It stores only the data that the section "Image hashes and thumbnails" lists.

To check a match with an older post, the app can fetch the image of that older post again. It does not store this copy.

## What the app shares

The app shares no data with anyone outside Reddit. It has no external server. It has no ads. It does not sell or license data. It does not give data to third parties.

## Who can see the data

- The app code of an installation reads the data of that installation. It cannot read the data of the other subreddit.
- The moderators see parts of the data in the mod menu items "AWB: status", "AWB: explain", and "AWB: shadow report". They also receive modmail alerts from the app.
- Reddit's mod log shows each action of the app. Reddit decides how long it keeps the mod log.
- The author of the app can read the app logs with the Devvit command-line tool.
- Reddit runs the app and its storage. Reddit's [Privacy Policy](https://www.reddit.com/policies/privacy-policy) applies to how Reddit handles data.

## How the app deletes data

**Deleted or removed posts.** Reddit tells the app when a post is deleted or removed. This includes a deletion by the author and a removal by a moderator, an admin, or the app. The app then deletes the hashes and the thumbnail of the post. This takes about one minute. If the app is busy, it can take longer.

The app keeps records that hold no content. They hold only IDs, numbers, status, and times. They expire as the table above shows.

One exception: when AutoModerator holds a post for review, the app keeps the data. A moderator can still approve the post.

**Expiry.** Each Redis value, except the work queue and the app status, has an expiry time. Reddit's storage deletes the value at that time.

**User IDs.** The app stores the user ID of a post author in the rate-limit record only. This record expires when the rate-limit window ends. The window is 30 days at most. This is also true when the user deletes the account.

**Uninstall.** When the moderators uninstall the app from a subreddit, Devvit removes the data and the settings of that installation. The moderators cannot recover them. A reinstall does not bring them back.

**Your choices.** To remove the data of your post sooner, delete the post on Reddit. To ask a question about your data, send a modmail to the moderators.

## Changes to this policy

The author can change this policy. The date at the top shows the last change.

## Contact

Send a modmail to the moderators of the subreddit:

- [r/Animewallpaper](https://reddit.com/message/compose/?to=/r/Animewallpaper)
- [r/AnimePhoneWallpapers](https://reddit.com/message/compose/?to=/r/AnimePhoneWallpapers)

The author of AWB3 is the Reddit user u/LZ58840.
