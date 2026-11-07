// Expected texts produced by RUNNING the message-building methods of the legacy bot (moderator_worker/rules.py,
// branch new_rate_limiting_control, commit 3d7b065; static extraction with `ast`, DB and Reddit code left out) on invented
// rows. Legacy numbers the failed images 1..k; the rows below fail in gallery order from the first image, so the
// numbers equal the D1 gallery positions.

export const MISMATCH_TWO_TAGS =
  '\n\n- **Mismatched resolutions in title.** Please ensure the resolutions tagged in the title exactly match the resolutions of your submitted images.\n\n\t- Tagged resolutions in title: 1920x1080, 3840x2160\n\n\t- Mismatched resolutions: 1600x1200, 1280x720';

export const BAD_RESOLUTION_ALL_ORIENTATIONS =
  '\n\n- **Bad resolution.**\n\n\t- Horizontal images must be at least **1920x1080**.\n\n\t\t- [Image #1 (1600x1200)](https://i.redd.it/g1.png), [Image #3 (1280x720)](https://i.redd.it/g3.png) are too small.\n\n\t- Vertical images must be at least **900x1600**.\n\n\t\t- [Image #2 (800x1500)](https://i.redd.it/g2.png) is too small.\n\n\t- Square images must be at least **1000x1000**.\n\n\t\t- [Image #4 (500x500)](https://i.redd.it/g4.png) is too small.';

export const ASPECT_MIXED =
  '\n\n- **Bad aspect ratio.**\n\n\t- Horizontal images must have an aspect ratio **between 16:10 (1.6:1) and 2:1 (2.0:1)**.\n\n\t\t- [Image #1 (1.333:1)](https://i.redd.it/r1.png) is too tall.\n\n\t\t- [Image #2 (2.400:1)](https://i.redd.it/r2.png), [Image #4 (2.100:1)](https://i.redd.it/r4.png) are too wide.\n\n\t- Vertical images must have an aspect ratio **of or taller than 10:16 (0.625:1)**.\n\n\t\t- [Image #3 (0.750:1)](https://i.redd.it/r3.png) is too wide.';

export const FLAIR_MULTI =
  '\n\n- Horizontal images are not allowed under the **Art** flair.\n\n\t- [Image #1](https://i.redd.it/f1.png), [Image #2](https://i.redd.it/f2.png) are horizontal.\n\n- Square images are not allowed under the **Art** flair.\n\n\t- [Image #3](https://i.redd.it/f3.png) is square.';

export const TWO_REASONS_PHONE_SUB =
  'Thank you for contributing to r/AnimePhoneWallpapers! Unfortunately, your submission was removed for the following reasons:\n\n- Horizontal images are not allowed under the **Art** flair.\n\n\t- [Image #1](https://i.redd.it/f1.png), [Image #2](https://i.redd.it/f2.png) are horizontal.\n\n- Square images are not allowed under the **Art** flair.\n\n\t- [Image #3](https://i.redd.it/f3.png) is square.\n\n- **Missing source in comments.** Timeout after 2 hours.\n\n\t- Please make a top level comment crediting the original source artwork/artist.\n\n\t\t- Try doing a search for the artwork on [SauceNAO](https://saucenao.com/) or [IQDB](https://iqdb.org/?css=1).\n\n\t\t- If you edited this wallpaper, please provide the sources of all artworks used.\n\n\t\t- If source is from official media, please cite the episode, chapter, volume, etc.\n\n\t- Respect the artist and their work - do not impersonate, steal from, or infringe on the copyright of other artists.\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit](https://reddit.com/message/compose/?to=/r/AnimePhoneWallpapers) if you have any questions or concerns.*';

export const LIMIT_LOWER_ONLY =
  'of or wider than 16:10 (1.6:1)';

export const LIMIT_UPPER_ONLY =
  'of or taller than 21:9 (2.333:1)';

export const LIMIT_BOTH =
  'between 9:21 (0.429:1) and 10:16 (0.625:1)';

export const LIMIT_BOTH_INTEGER =
  'between 1:1 (1.0:1) and 2:1 (2.0:1)';

export const LIMIT_16_9_TO_4_3 =
  'between 16:9 (1.778:1) and 4:3 (1.333:1)';
