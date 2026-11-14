# S2, S3 and S4 playtest app (animewallpaperbotv3)

This app is a test tool. It does not moderate. It writes what Reddit sends to its log. You run it in your test subreddit r/LZ58840. You make test posts. You save the log. The agent reads the log and finishes the spikes S2, S3 and S4 of the plan (`.omc/plans/ralplan-awb3-devvit-rewrite.md`, section 2).

This build is also the domain request of plan step 0.9 (spike S5). It asks Reddit to approve the fetch of `i.redd.it` and `preview.redd.it`.

This app is the same Reddit app as the main app: `animewallpaperbotv3`. Reddit approves a fetch domain for an app, not for one build. The later `npx devvit upload` from the repo root makes a newer version of this app. That version replaces this playtest build. To go back to the latest uploaded version at any time, run `npx devvit install r/LZ58840 animewallpaperbotv3@latest`.

## Fetch Domains

The following domains are requested for this app:

- `i.redd.it` - The AWB3 moderation app reads the image of a new post in the subreddit where it is installed. It computes a perceptual hash of the image for its repost check. This build tests that fetch.
- `preview.redd.it` - Same use. The app fetches the smallest preview image that Reddit gives for the same post. It reads only the images of posts in the installed subreddit. It sends no user data.

In this build, the fetch is off. A moderator turns it on with the setting "S6: fetch probe". When it is on, the app fetches one image for each post that it logs.

## What you need

- The repo with `npm ci` done in the repo root. This folder has no `package.json`. The CLI and the build use the `node_modules` of the repo root.
- The Reddit account that registered `animewallpaperbotv3`. The CLI must be logged in with this account (`npx devvit login`).
- A moderator account for r/LZ58840. The account that registered the app can be this account. The subreddit must have fewer than 200 members (a rule of `playtest`).
- The account u/LZ58842. It makes all test posts. It must be able to post in r/LZ58840. Do not use u/AnimewallpaperBot for posts. The main app has a special path for that user.
- `magick` (ImageMagick) and `ffmpeg`, to make the test files. Both are installed on this machine.
- Two browser profiles (or one normal window and one private window): one logged in as the moderator, one logged in as u/LZ58842.

Run all commands in this folder: `cd spikes/s2s3`. Do not run `npx devvit init` or `npx devvit publish` here. Do not run `upload` or `playtest` in the repo root for this test: that uploads the main app.

## Step 1. Save the Terms and Privacy links (S5)

Reddit needs the links before it reviews a domain request.

1. Open https://developers.reddit.com/apps/animewallpaperbotv3.
2. In the app details form, save the public URL of the Terms (the r/Animewallpaper wiki page `awb-terms`) and the public URL of the Privacy policy (the wiki page `awb-privacy`). These pages are copies of `TERMS.md` and `PRIVACY.md`; when you change a file, update its page. In the copies, the link to `PRIVACY.md` (Terms) and to `TERMS.md` (Privacy) must be the full page URLs (`https://www.reddit.com/r/Animewallpaper/wiki/awb-privacy` and `.../wiki/awb-terms`). Open both pages when you are not logged in: each must show, and its link must work.

## Step 2. Make the test files

```bash
mkdir -p spike-images && cd spike-images
for size in 1920x1080 3840x2160 7680x4320 900x1600; do
  magick -size $size gradient:'#ff6600-#0044ff' $size-a.png
  magick -size $size gradient:'#ff6600-#0044ff' -quality 90 $size-a.jpg
  magick -size $size gradient:'#00aa44-#ffee00' $size-b.png
  magick -size $size gradient:'#00aa44-#ffee00' -quality 90 $size-b.jpg
done
ffmpeg -loglevel error -f lavfi -i testsrc=duration=3:size=640x360:rate=15 -pix_fmt yuv420p video.mp4
cd ..
```

This takes about 10 seconds. You get 16 image files (`<size>-a` and `<size>-b`, PNG and JPEG) and one video. A single post uses the `-a` file. A gallery post uses the `-a` file and the `-b` file.

## Step 3. Set up r/LZ58840

1. Make sure the subreddit has at least one post flair (Mod tools, Post flair). Call it `Desktop`. Add a second one, `Mobile`.
2. Open https://www.reddit.com/r/LZ58840/wiki/edit/config/automoderator and save this rule. The title word is `filterme`.

```yaml
---
type: submission
title (includes): ["filterme"]
moderators_exempt: false
action: filter
action_reason: "S2 spike: title word"
---
```

If Reddit refuses to save this rule ("filter" and "remove" are no longer allowed in new AutoModerator configurations), do this instead:

- If Mod tools has **Automations** and an Automation can hold a post for review (filter, or send to the mod queue without a removal) when the title includes `filterme`, make that Automation. Then continue as written. Tell the agent that an Automation (not AutoModerator) filtered S2-21.
- Else skip this step. In step 6, skip the post S2-21, its approval in item 7, and its "S2: dump post" at the end. All other steps stay the same. Do not use Crowd Control or a karma filter: it would hold all posts of u/LZ58842 and break the other cases.

The 3.0 app does not depend on the AutoModerator case. Its sweep reads the mod queue every 5 minutes, and a filtered post is not skipped as removed. The exact field values of a filtered post then stay unconfirmed.

## Step 4. The post that you make before the install (S2 j)

The question: does `onPostDelete` arrive for a post that is older than the install?

1. If the app is installed in r/LZ58840, run `npx devvit uninstall r/LZ58840`. This deletes the settings and the Redis data of the app in this subreddit. It does not matter for a test subreddit. If the CLI says that the app is not installed, go on.
2. As u/LZ58842, make a text post in r/LZ58840 with the title `S2-27 before install`. Do not delete it yet.

## Step 5. Install the build

```bash
cd spikes/s2s3
npx devvit playtest r/LZ58840
```

The CLI builds the app (`scripts.dev` in `devvit.json` runs esbuild), uploads a playtest version, installs it in r/LZ58840, and streams the log. This also sends the domain request to Reddit (S5). Leave the command running while you work. You can stop it with Ctrl+C at any time. The build stays installed.

If you see "That app already exists, and you can't playtest someone else's app", the CLI is logged in with the wrong account. Run `npx devvit logout`, then `npx devvit login`. If the CLI starts to create a new app, press Ctrl+C. The app exists already.

When it is installed, do these two things:

1. As u/LZ58842, delete the post `S2-27 before install`.
2. Click the menu item "S3: probe platform" (the three-dot menu of the subreddit page). This is the first probe. It shows the form of a select setting that nobody changed.

## Step 6. Make the posts

Make every post as u/LZ58842 in r/LZ58840. Type the title exactly: the table of the agent uses the title as the name of the case. Wait about 20 seconds between posts.

| Title | What to post |
|---|---|
| `S2-01 png 1920x1080 single` | Image post, file `spike-images/1920x1080-a.png` |
| `S2-02 jpg 1920x1080 single` | Image post, file `spike-images/1920x1080-a.jpg`. Choose the flair `Desktop` |
| `S2-03 png 3840x2160 single` | Image post, file `3840x2160-a.png` |
| `S2-04 jpg 3840x2160 single` | Image post, file `3840x2160-a.jpg` |
| `S2-05 png 7680x4320 single` | Image post, file `7680x4320-a.png` |
| `S2-06 jpg 7680x4320 single` | Image post, file `7680x4320-a.jpg` |
| `S2-07 png 900x1600 single` | Image post, file `900x1600-a.png` |
| `S2-08 jpg 900x1600 single` | Image post, file `900x1600-a.jpg` |
| `S2-09 png 1920x1080 gallery` | Gallery post, files `1920x1080-a.png` and `1920x1080-b.png` |
| `S2-10 jpg 1920x1080 gallery` | Gallery post, files `1920x1080-a.jpg` and `1920x1080-b.jpg` |
| `S2-11 png 3840x2160 gallery` | Gallery post, files `3840x2160-a.png` and `3840x2160-b.png` |
| `S2-12 jpg 3840x2160 gallery` | Gallery post, files `3840x2160-a.jpg` and `3840x2160-b.jpg` |
| `S2-13 png 7680x4320 gallery` | Gallery post, files `7680x4320-a.png` and `7680x4320-b.png` |
| `S2-14 jpg 7680x4320 gallery` | Gallery post, files `7680x4320-a.jpg` and `7680x4320-b.jpg` |
| `S2-15 png 900x1600 gallery` | Gallery post, files `900x1600-a.png` and `900x1600-b.png` |
| `S2-16 jpg 900x1600 gallery` | Gallery post, files `900x1600-a.jpg` and `900x1600-b.jpg` |
| `S2-17 crosspost single` | First post `1920x1080-a.png` as an image post in your own profile (u/LZ58842), not in a community. Then crosspost it to r/LZ58840. Change the title in the crosspost dialog. If Reddit does not allow this, post the original in another subreddit where u/LZ58842 can post |
| `S2-18 crosspost gallery` | The same, with a gallery post (`1920x1080-a.jpg` and `1920x1080-b.jpg`) |
| `S2-19 external image link` | Link post. URL: `https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png` |
| `S2-20 video` | Video post, file `spike-images/video.mp4` |

Now the posts with moderator actions. Do them in this order.

1. `S2-21 automod filterme`: text post. AutoModerator filters it. Wait until it shows in the mod queue. Do not approve it yet.
2. `S2-22 mod removal`: text post. As the moderator, remove it (Remove, not spam). Do not approve it yet.
3. `S2-23 mod removal as spam`: text post. As the moderator, remove it as spam.
4. `S2-24 author delete`: text post. As u/LZ58842, delete it.
5. Optional: a post that Reddit's own spam filter holds. There is no sure way to make one. If the mod queue ever shows a post that Reddit filtered, tell the agent its title. Do not spend time on this.
6. Click the menu item "S2: dump listings" (three-dot menu of the subreddit page). This is dump 1. At this time S2-21 is filtered, S2-22 and S2-23 are removed, and S2-24 is deleted.
7. As the moderator, click Approve on S2-21. Click Approve on S2-22. Wait one minute.
8. Click "S2: dump listings" again. This is dump 2.
9. `S2-25 app removal`: text post. As the moderator, open the three-dot menu of the post. Click "S3: app comments and removes this post". The app writes a comment and removes the post.
10. `S2-26 flair change`: as the moderator, change the flair of the post `S2-02 jpg 1920x1080 single` (from `Desktop` to `Mobile`).
11. As u/LZ58842, write a comment on `S2-01 png 1920x1080 single`.

Last, wait 5 minutes. Then click "S2: dump post" (three-dot menu of a post) on S2-01, S2-21, S2-22, S2-23 and S2-25. These dumps show the final state of each post.

## Step 7. The select setting (S3)

1. Open https://developers.reddit.com/r/LZ58840/apps/animewallpaperbotv3 (the install settings page).
2. Set "S3: select probe" to B. Save.
3. Click "S3: probe platform" again. This is the second probe.

## Step 7b. Platform limits (S4)

Use the three-dot menu of the subreddit page, as the moderator. Wait for the toast of each item before you click the next one.

1. Click "S4: probe limits". It takes up to 30 seconds. The toast says "S4: logged Redis, WebAssembly and the 4K decode".
2. Click "S4: decode 8K". It takes up to 30 seconds (Devvit ends a request at 30 seconds), and it can fail with an error or a timeout. A failure is also a result. Do not click it again.

## Step 8. Save the log and give it to the agent

```bash
cd spikes/s2s3
npx devvit logs r/LZ58840 animewallpaperbotv3 --since 1d --json > spike-logs.jsonl
```

The command does not end. Run `wc -l spike-logs.jsonl` in a second terminal. When the number does not grow, press Ctrl+C in the first terminal. Reddit keeps 5,000 log events or 7 days. Do this on the same day.

Tell the agent that `spikes/s2s3/spike-logs.jsonl` is ready. The agent runs:

```bash
node spikes/s2s3/extract.mjs spikes/s2s3/spike-logs.jsonl
```

This writes the fixtures to `test/fixtures/payloads/` (ids and names replaced) and prints the S2 tables and the S3 checks.

**Keep `spike-logs.jsonl` private.** It has real Reddit user names and ids, and the text of posts and comments. Never commit it. Never upload it: not to GitHub, not to Reddit, not to any online service. Never leave it in a folder that `devvit upload` or `devvit publish` sends. Give it only to the agent on this machine. When the agent says that the fixtures are ready, delete it: `rm spikes/s2s3/spike-logs.jsonl`. Only the fixtures that `extract.mjs` writes (ids and names replaced) go into git. The file `.gitignore` of this folder keeps the log out of git when you work in this folder. The root `.gitignore` and the `sourceIgnores` of the root `devvit.json` must also list it.

## Step 9. The fetch probe (S6) and the domain request (S5)

The app can fetch only after Reddit approves the two domains. The request is sent when you run `playtest` or `upload`. Reddit answers in 1 to 2 business days, sometimes later. The approved domains show on https://developers.reddit.com/apps/animewallpaperbotv3/developer-settings.

1. Send the message of `.omc/drafts/reddit-week1-message.md` to Reddit (the App Migration Program and r/Devvit, as the file says). Use `animewallpaperbotv3` as the app name. Use the Terms and Privacy URLs of step 1.
2. When Reddit approves the domains, open the install settings page (step 7) and turn on "S6: fetch probe". Run `npx devvit playtest r/LZ58840` again if the build is not installed.
3. Make three new image posts as u/LZ58842, or click "S2: dump post" on old posts. Save the log again (step 8). The `s6` lines show the answer of the fetch: status, type, size and the first 16 bytes.

You can also turn the fetch probe on before the approval. The log then shows the error text of the refused fetch. That text is also a result.

## Build by hand (not needed)

`npx devvit playtest` and `npx devvit upload` build the app themselves. To build in this folder without the CLI:

```bash
PATH=../../node_modules/.bin:$PATH sh -c "$(node -p "require('./devvit.json').scripts.build")"
```

This writes `dist/server/index.cjs`.
