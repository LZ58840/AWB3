"""Week-1 export for the AWB3 tests (plan: 0.6, 7.6, S9): the replay corpus, its legacy config and the legacy repost labels.

Run it before Jan 12, 2027 (it needs the Data API), on the legacy host or anywhere that reaches the legacy db, in a clone
of this repo (the tool refuses to run unless git ignores test/fixtures/private/, so the private labels cannot be committed):

  capture_fixtures.py --sub Animewallpaper --sub AnimePhoneWallpapers [--posts 300]

It reads the legacy db (SELECT only) and Reddit (read only) and writes to test/fixtures/:

  legacy-config-<sub>.yaml            in git. The live `awb` wiki page of the subreddit (1 request), written again in block
      style. The usernames in except_authors are replaced by the pseudonyms of the corpus below (so the replay matches
      them); AutoModerator stays. The comments of the page are dropped. It replaces the file of the same name.
  legacy-corpus-<sub>.json            in git. The newest --posts posts that are older than 48 h (the legacy bot has
      finished with them): {"subreddit", "posts": [{"id", "author", "createdUtc", "title", "flair", "images",
      "sourceCommentUtc", "legacy"}]}. "images" = what the legacy db stored: [{"url", "width", "height"}], in order.
      "title" = only the resolution tags (the only part that a rule reads). "flair" is kept as it is: the flair rule needs
      it, and it is text that the mods set. "sourceCommentUtc" = time of the first top-level comment of the author, or
      null. "legacy" = {"action": "remove" | "report" | "none", "comment": text of the legacy bot comment, "moderated":
      legacy db flag, "removedBy": "awb" | "automod" | "mod" | "reddit" | null, "approved", "deleted"}. Usernames (not AutoModerator),
      post IDs and image URLs are replaced by pseudonyms, the same everywhere in the run. Every time (createdUtc,
      sourceCommentUtc, and the time that a rate-limit comment names) moves by one random offset per run, 1 to 3 years
      back: the intervals stay equal, and the replay uses only intervals. The tool refuses to write the file if a real
      username or ID is left in any string of it.
  private/legacy-repost-labels-<sub>.json   NOT in git (test/fixtures/private/ is gitignored). Real IDs, URLs and times.
      One record per image match in a legacy repost comment: {"subreddit", "postId", "createdUtc", "imageIndex",
      "imageUrl", "matchedPostId", "matchedImageUrl", "certainty", "age", "outcome"}. "outcome": "kept" (the post is
      still removed), "reversed" (a mod approved it) or "unknown". It covers all posts of the legacy db that the
      bot finished and that are removed or approved, so it takes 1 request each (about 1 per second: some hours).

Progress goes to stderr; the last line per subreddit tells whether the corpus covers every rule.

Reddit credentials: this tool stores none. PRAW reads them from environment variables or from praw.ini (for example
~/.config/praw.ini, section [DEFAULT], chmod 600):
  praw_client_id, praw_client_secret, praw_refresh_token   (legacy .env names: AWB_CLIENT_ID, AWB_CLIENT_SECRET, AWB_TOKEN)
  or, for a script app: praw_client_id, praw_client_secret, praw_username, praw_password
The account must moderate each subreddit, with the wiki permission (the awb page is for mods only; the fields banned_by
and approved_by are for moderators). Scopes: read and wikiread.
PRAW also reads ./praw.ini of the current folder: run the tool from a folder that only you control.
Python 3.10+ and `pip install -r tools/requirements.txt` (PRAW and PyYAML).

Legacy db: no credentials here. --db-cmd is the command that reads SQL from stdin and prints rows like `mysql -N -B`.
The default runs the mysql client inside container awb_mysql, which has the password in its own environment.
To use another machine or a restored dump, give another command, for example "ssh legacy-host docker exec -i ...".
"""

import argparse
import json
import re
import secrets
import shlex
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

BOT = "AnimewallpaperBot"
PUBLIC_USERS = {"AutoModerator"}  # not a person; the legacy config lists it in except_authors, so the corpus keeps the name too
DB_CMD = """docker exec -i awb_mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u animewallpaperbot -N -B awb'"""  # not -p: it shows in `ps`
USER_AGENT = "script:awb3-capture-fixtures:v1 (by u/AnimewallpaperBot)"
FINAL_HOURS = 48  # the legacy bot checks a post again for 48 h (legacy inventory 3.6); older posts are final
TAG = re.compile(r"[(\[]\s?[0-9]{3,}\s?[Xx×]\s?[0-9]{3,}\s?[)\]]")  # legacy rules.py:41-68, without the groups
POST_LINK = re.compile(r"\[([0-9a-z]+)\]\(https://redd\.it/\1\)")  # how the legacy comment templates write a post
IMAGE_URL = re.compile(r"https?://[^\s)\]]*\.(?:png|jpg|jpeg)", re.I)
WAIT_UNTIL = re.compile(r"\*\*(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) UTC\*\*")  # RateLimitAny: "Please wait until **<time> UTC**"
# rules.py:360-362: [Image #n](url) matched submission [id](https://redd.it/id) (age, [pct% certainty](matched url))
MATCH = re.compile(r"\[Image #(\d+)\]\((\S+?)\) matched submission \[([0-9a-z]+)\]\(https://redd\.it/\3\) \(([^,]+), \[([0-9.]+)% certainty\]\((\S+?)\)\)")
RULES = {  # markers of the legacy comment templates (rules.py), in rule order
    "flair": "images are not allowed under the **",
    "mismatch": "**Mismatched resolution",
    "resolution": "**Bad resolution.**",
    "aspect": "**Bad aspect ratio.**",
    "rate limit": "**Rate limit reached.**",
    "source": "**Missing source in comments.**",
    "repost": "**Repost detected.**",
}


def sub_name(name):  # a subreddit name goes into SQL text and file names
    if not re.fullmatch(r"[A-Za-z0-9_]{1,21}", name):
        raise ValueError(name)
    return name


class Anon:
    """Pseudonyms and one time offset: a real value gets the same pseudonym in every file of a run, and every time moves by
    the same number of seconds (intervals stay equal). Nothing is saved to undo them."""

    def __init__(self, offset=0):
        self.maps = {"user": {}, "post": {}, "image": {}}
        self.offset = offset

    def time(self, ts):
        return ts + self.offset

    def clock(self, text):  # a time as a rate-limit comment prints it: UTC, "2024-12-04 15:20:00"
        moved = datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc).timestamp() + self.offset
        return datetime.fromtimestamp(moved, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    def _get(self, kind, real, make):
        m = self.maps[kind]
        if real not in m:
            m[real] = make(len(m) + 1)
        return m[real]

    def user(self, name):
        return name if name in PUBLIC_USERS else self._get("user", name, "user{:05d}".format)

    def post(self, post_id):  # 6 characters of 0-9a-z, like a Reddit post ID
        return self._get("post", post_id, "p{:05d}".format)

    def image(self, url):  # the file name is an ID too; host and extension stay, because rules look at them
        u = urlsplit(url)
        return self._get("image", url, lambda n: f"{u.scheme}://{u.netloc}/i{n:05d}.{u.path.rpartition('.')[2]}")


def scrub(text, anon):
    """Replace the post IDs and image URLs in a legacy bot comment, and move the time that a rate-limit comment names."""
    text = POST_LINK.sub(lambda m: f"[{anon.post(m[1])}](https://redd.it/{anon.post(m[1])})", text)
    text = WAIT_UNTIL.sub(lambda m: f"**{anon.clock(m[1])} UTC**", text)
    return IMAGE_URL.sub(lambda m: anon.image(m[0]), text)


def tags_only(title):
    """The only part of a title that a rule reads is the resolution tags; the rest could identify the post."""
    return " ".join(TAG.findall(title))


def group_rows(rows):
    """Rows (id, author, created_utc, moderated, image url, width, height) as `mysql -N -B` prints them -> one dict per post."""
    posts = {}
    for pid, author, created, moderated, url, width, height in rows:
        post = posts.setdefault(pid, {"id": pid, "author": author, "createdUtc": int(created), "moderated": moderated == "1", "images": []})
        if url != "NULL":
            post["images"].append({"url": url, "width": int(width), "height": int(height)})
    return list(posts.values())


def legacy_decision(comments, bot):
    """What the legacy bot did, from its comment: ("remove" | "report" | "none", comment text).

    A removal keeps the bot's sticky comment; report-only mode (moderator_worker/__init__.py:117-121) removes it again.
    """
    for c in comments:
        if (c["author"] or "").lower() == bot.lower() and c["body"].startswith("Thank you for contributing to r/"):
            return ("report" if c["removed"] else "remove"), c["body"]
    return "none", None


def removed_by(banned_by, bot):  # usernames of moderators stay out of the corpus
    if banned_by is None:
        return None
    if not isinstance(banned_by, str):  # True: Reddit's spam filter or the admins removed it (no name given)
        return "reddit" if banned_by else None
    return "awb" if banned_by.lower() == bot.lower() else "automod" if banned_by == "AutoModerator" else "mod"


def build_post(post, fetched, anon, bot):
    """One post of the replay corpus: what a simulator needs to submit it, and what the legacy bot did with it."""
    action, body = legacy_decision(fetched["comments"], bot)
    author_comments = [c["createdUtc"] for c in fetched["comments"] if c["author"] == post["author"]]
    return {
        "id": anon.post(post["id"]),
        "author": anon.user(post["author"]),
        "createdUtc": anon.time(post["createdUtc"]),
        "title": tags_only(fetched["title"]),
        "flair": fetched["flair"],
        "images": [{"url": anon.image(i["url"]), "width": i["width"], "height": i["height"]} for i in post["images"]],
        "sourceCommentUtc": anon.time(min(author_comments)) if author_comments else None,  # SourceCommentAny: the first comment of the author
        "legacy": {
            "action": action,
            "comment": scrub(body, anon) if body else None,
            "moderated": post["moderated"],
            "removedBy": removed_by(fetched["bannedBy"], bot),
            "approved": fetched["approvedBy"] is not None,
            "deleted": fetched["removedByCategory"] == "deleted",
        },
    }


def repost_labels(sub, post_id, created, fetched, bot):
    """One record per image match in a legacy repost comment, with what the mods did with the post afterwards (S9)."""
    _, body = legacy_decision(fetched["comments"], bot)
    if not body or RULES["repost"] not in body:
        return []
    outcome = "kept" if fetched["bannedBy"] else "reversed" if fetched["approvedBy"] else "unknown"
    return [
        {"subreddit": sub, "postId": post_id, "createdUtc": created, "imageIndex": int(n), "imageUrl": url, "matchedPostId": matched,
         "matchedImageUrl": matched_url, "certainty": float(pct), "age": age, "outcome": outcome}
        for n, url, matched, age, pct, matched_url in MATCH.findall(body)
    ]


def corpus_sql(sub, limit, until):
    """The newest `limit` posts of a subreddit that are not newer than `until`, with their stored images, oldest first."""
    return (
        "SELECT s.id, s.author, s.created_utc, s.moderated, i.url, i.width, i.height FROM"
        f" (SELECT * FROM submissions WHERE subreddit = '{sub_name(sub)}' AND created_utc <= {int(until)} ORDER BY created_utc DESC LIMIT {int(limit)}) s"
        " LEFT JOIN images i ON i.submission_id = s.id ORDER BY s.created_utc, s.id, i.id;"
    )


def candidates_sql(sub):
    """Posts that the legacy bot finished (moderated) and that were removed or approved: the repost removals are among them."""
    return f"SELECT id, created_utc FROM submissions WHERE subreddit = '{sub_name(sub)}' AND moderated AND (removed OR approved) ORDER BY created_utc;"


def parse_tsv(text):
    return [line.split("\t") for line in text.splitlines()]


RETRY_WAITS = (10, 60, 300)  # seconds before each retry of a failed Reddit request (prawcore already retried twice)


def capture(sub, db, fetch, anon, bot, posts, until, sleep=time.sleep):
    """Build (corpus, labels) of one subreddit.

    db(sql) runs SQL on the legacy db and returns the rows as `mysql -N -B` prints them.
    fetch(post_id) returns the Reddit side of a post (see fetch_post), or None when Reddit says 404.
    A request that still fails after the retries skips its post: one network error must not lose a run of some hours.
    """
    fetched = {}

    def get(post_id):
        if post_id not in fetched:
            for wait in (*RETRY_WAITS, None):
                try:
                    fetched[post_id] = fetch(post_id)
                    if fetched[post_id] is None:
                        print(f"skipped {post_id}: Reddit has no such post", file=sys.stderr)
                    break
                except Exception as error:  # not KeyboardInterrupt: Ctrl+C still stops the run
                    if wait is None:
                        fetched[post_id] = None
                        print(f"skipped {post_id}: {type(error).__name__}: {error}", file=sys.stderr)
                    else:
                        sleep(wait)
            if len(fetched) % 100 == 0:
                print(f"{sub}: {len(fetched)} posts read from Reddit", file=sys.stderr)
        return fetched[post_id]

    corpus = {"subreddit": sub, "posts": []}
    for post in group_rows(parse_tsv(db(corpus_sql(sub, posts, until)))):
        if fetched_post := get(post["id"]):
            corpus["posts"].append(build_post(post, fetched_post, anon, bot))
    labels = []
    for post_id, created in parse_tsv(db(candidates_sql(sub))):
        if fetched_post := get(post_id):
            labels += repost_labels(sub, post_id, int(created), fetched_post, bot)
    return corpus, labels


def strings(value):
    """Every string in a JSON value."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)


def leaks(value, anon):
    """Real usernames, post IDs and image URLs of this run that are still in a string of the value.

    A user name counts as a whole word (letters, digits, _ and -), without regard to case, so "art" is not found in
    "artist". A post ID counts as a whole run of letters and digits, so "t3_<id>" is found. An image URL counts as a substring.
    """
    texts = list(strings(value))
    names = {word.lower() for text in texts for word in re.findall(r"[A-Za-z0-9_-]+", text)}
    runs = {run for text in texts for run in re.findall(r"[0-9a-z]+", text.lower())}
    m = anon.maps
    return [u for u in m["user"] if u.lower() in names] + [p for p in m["post"] if p in runs] + [url for url in m["image"] if any(url in t for t in texts)]


def corpus_text(corpus, anon):
    if found := leaks(corpus, anon):  # this file goes to git
        raise SystemExit(f"error: real values are left in the corpus of {corpus['subreddit']}; the public file is not written: {found[:5]}")
    return json.dumps(corpus, indent=2, ensure_ascii=False) + "\n"


def summary(corpus, labels):
    """One line for the owner: does the corpus cover every rule? (AC3 replays it)"""
    posts = corpus["posts"]
    actions = Counter(p["legacy"]["action"] for p in posts)
    rules = Counter(rule for p in posts for rule, marker in RULES.items() if marker in (p["legacy"]["comment"] or ""))
    outcomes = Counter(label["outcome"] for label in labels)

    def fmt(counter):
        return ", ".join(f"{k} {v}" for k, v in sorted(counter.items())) or "-"

    line = f"{corpus['subreddit']}: {len(posts)} posts | legacy: {fmt(actions)} | rules in comments: {fmt(rules)} | repost label pairs: {fmt(outcomes)}"
    return line + (" | WARNING: plan 0.6 wants at least 200 posts" if len(posts) < 200 else "")


def fetch_post(reddit, post_id):
    """The Reddit side of a post as plain data, or None for 404. The only code here that touches PRAW objects."""
    from prawcore.exceptions import NotFound

    try:
        post = reddit.submission(post_id)
        # shortcut: limit=0 drops the "load more" stubs, so an author comment among very many top-level comments can be
        # missed (sourceCommentUtc null). Raise the limit if such a post matters.
        post.comments.replace_more(limit=0)
        return {
            "title": post.title,
            "flair": post.link_flair_text,
            "bannedBy": post.banned_by,
            "approvedBy": post.approved_by,
            "removedByCategory": post.removed_by_category,
            "comments": [
                {"author": c.author.name if c.author else None, "body": c.body, "createdUtc": int(c.created_utc), "removed": bool(c.banned_by)}
                for c in post.comments
            ],
        }
    except NotFound:
        return None


def fetch_config(reddit, sub):
    """The text of the `awb` wiki page of the subreddit, or None when there is none."""
    from prawcore.exceptions import NotFound

    try:
        return reddit.subreddit(sub).wiki["awb"].content_md
    except NotFound:
        return None


def anonymize_config(text, anon, sub):
    """The `awb` wiki page as the replay reads it. Usernames in except_authors get the pseudonyms of the corpus.

    The page is read as YAML and written again in block style, like the legacy bot writes it, so its comments are dropped.
    """
    import yaml  # late, so that --help and the corpus functions need no PyYAML

    page = yaml.safe_load(text)
    if not isinstance(page, dict):
        raise SystemExit(f"error: the awb wiki page of r/{sub} is not a YAML map")
    names = page.get("except_authors")
    if isinstance(names, list):
        page["except_authors"] = [anon.user(str(name)) for name in names]
    elif names is not None:
        raise SystemExit(f"error: except_authors of the awb wiki page of r/{sub} is not a list")
    header = (f"# Anonymized copy of the live `awb` wiki page of r/{sub} (tools/capture_fixtures.py): usernames except AutoModerator are the pseudonyms"
              " of the corpus; comments are dropped.\n")
    return header + yaml.safe_dump(page, sort_keys=False, allow_unicode=True, width=1_000_000)


def git_ignores(path):
    """True when git ignores the path (`git check-ignore`). False when it does not, and when git or the repository is not there."""
    path = Path(path).resolve()
    here = next(folder for folder in path.parents if folder.exists())  # the folder of the path may not be there yet
    try:
        return subprocess.run(["git", "check-ignore", "-q", "--", str(path)], cwd=here, capture_output=True).returncode == 0
    except FileNotFoundError:  # no git
        return False


def real_io(db_cmd):
    import praw  # late, so that --help needs no praw

    reddit = praw.Reddit(user_agent=USER_AGENT, check_for_updates=False)

    def db(sql):
        return subprocess.run(shlex.split(db_cmd), input=sql, capture_output=True, text=True, check=True).stdout

    return db, lambda post_id: fetch_post(reddit, post_id), lambda sub: fetch_config(reddit, sub)


def main(argv=None, io=None, offset=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sub", action="append", required=True, type=sub_name, help="subreddit name; repeat it for more")
    ap.add_argument("--posts", type=int, default=300, help="posts per subreddit in the corpus (default 300; some are lost to 404s)")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "test" / "fixtures", help="default: test/fixtures of this repo")
    ap.add_argument("--db-cmd", default=DB_CMD, help="command that runs SQL from stdin on the legacy db (see above)")
    args = ap.parse_args(argv)
    private = args.out / "private"
    private.mkdir(parents=True, exist_ok=True)
    for sub in args.sub:  # before any request: the labels hold real IDs and must never reach git
        if not git_ignores(private / f"legacy-repost-labels-{sub.lower()}.json"):
            raise SystemExit(
                f"error: git does not ignore {private} (`git check-ignore` says no; it also says no outside a repository, or without git), "
                "so the private labels could be committed. Run the tool in a clone of the repo (its .gitignore lists test/fixtures/private/), "
                "or put --out in one. Nothing was read from Reddit."
            )
    db, fetch, config = io or real_io(args.db_cmd)
    if offset is None:  # one random offset for the whole run: 1 to 3 years back
        offset = -(365 * 86400 + secrets.randbelow(2 * 365 * 86400))
    anon = Anon(offset)
    until = int(time.time()) - FINAL_HOURS * 3600
    for sub in args.sub:  # the configs come first: a missing wiki page or a Reddit error shows at once, not after hours
        text = config(sub)
        if text is None:
            print(f"{sub}: no wiki page awb; no config written", file=sys.stderr)
            continue
        (args.out / f"legacy-config-{sub.lower()}.yaml").write_text(anonymize_config(text, anon, sub))
        print(f"{sub}: wrote legacy-config-{sub.lower()}.yaml")
    status = 0
    for sub in args.sub:
        corpus, labels = capture(sub, db, fetch, anon, BOT, args.posts, until)
        (private / f"legacy-repost-labels-{sub.lower()}.json").write_text(json.dumps(labels, indent=2) + "\n")
        try:
            (args.out / f"legacy-corpus-{sub.lower()}.json").write_text(corpus_text(corpus, anon))
        except SystemExit as refused:  # keep the hours of work where git cannot see it; the owner reads it and asks the agent
            (private / f"legacy-corpus-{sub.lower()}.json").write_text(json.dumps(corpus, indent=2, ensure_ascii=False) + "\n")
            print(f"{refused}. It is saved in {private} instead (private: do not commit it).", file=sys.stderr)
            status = 1
        print(summary(corpus, labels))
    return status


if __name__ == "__main__":
    raise SystemExit(main())
