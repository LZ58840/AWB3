"""Makes test/fixtures/legacy-corpus-sample.json: a small replay corpus made by the transform functions of tools/capture_fixtures.py
(Anon, group_rows, build_post, legacy_decision, scrub, tags_only, corpus_text) on INVENTED legacy rows and Reddit data.
It is a contract fixture: the replay reads exactly what the tool writes.

  tools/.venv/bin/python -I test/replay/make_sample.py          (from the repo root; writes the file, prints the summary line)
  tools/.venv/bin/python -I test/replay/make_sample.py --check  (exit 1 when the file is not what the tool writes now: the contract)

The legacy comments are the verbatim templates of the legacy bot (legacy requirements L 2.2) filled with the invented posts.
Each post below is one case of the replay; test/fixtures/legacy-config-sample.yaml holds the legacy settings that these comments follow.
"""
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tools"))
from capture_fixtures import Anon, capture, corpus_text, summary  # noqa: E402

SUB, BOT, BASE = "Animewallpaper", "AnimewallpaperBot", 1796722800  # BASE = 2026-12-08T11:00:00Z

# ---- the legacy templates (L 2.2), filled in
FRAME = "Thank you for contributing to r/{sub}! Unfortunately, your submission was removed for the following reason{many}:"
SIGNATURE = ("\n\n*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit]"
             "(https://reddit.com/message/compose/?to=/r/{sub}) if you have any questions or concerns.*")
SOURCE_HELP = (
    "\n\n\t- Please make a top level comment crediting the original source artwork/artist."
    "\n\n\t\t- Try doing a search for the artwork on [SauceNAO](https://saucenao.com/) or [IQDB](https://iqdb.org/?css=1)."
    "\n\n\t\t- If you edited this wallpaper, please provide the sources of all artworks used."
    "\n\n\t\t- If source is from official media, please cite the episode, chapter, volume, etc."
    "\n\n\t- Respect the artist and their work - do not impersonate, steal from, or infringe on the copyright of other artists."
)


def comment(*sections):
    many = "" if len(sections) == 1 else "s"
    return FRAME.format(sub=SUB, many=many) + "".join(sections) + SIGNATURE.format(sub=SUB)


def image(i, url, w, h):  # a resolution or aspect link
    return f"[Image #{i} ({w}x{h})]({url})"


def mismatch(tagged, mismatched):  # one tag, one mismatch
    return ("\n\n- **Mismatched resolution in title.** Please ensure the resolution tagged in the title exactly matches the resolution of your submitted image."
            f"\n\n\t- Tagged resolution in title: {tagged}\n\n\t- Mismatched resolution: {mismatched}")


def bad_resolution(orientation, minimum, bad):  # bad = [(n, url, w, h)]
    links = ", ".join(image(*b) for b in bad)
    return (f"\n\n- **Bad resolution.**\n\n\t- {orientation.capitalize()} images must be at least **{minimum}**."
            f"\n\n\t\t- {links} {'are' if len(bad) != 1 else 'is'} too small.")


def bad_aspect(orientation, threshold, bad, ratios):  # too tall
    links = ", ".join(f"[Image #{n} ({r}:1)]({url})" for (n, url), r in zip(bad, ratios))
    return (f"\n\n- **Bad aspect ratio.**\n\n\t- {orientation.capitalize()} images must have an aspect ratio **{threshold}**."
            f"\n\n\t\t- {links} {'are' if len(bad) != 1 else 'is'} too tall.")


def flair(orientation, flair_text, urls):
    links = ", ".join(f"[Image #{i}]({u})" for i, u in enumerate(urls, 1))
    return (f"\n\n- {orientation.capitalize()} images are not allowed under the **{flair_text}** flair."
            f"\n\n\t- {links} {'are' if len(urls) != 1 else 'is'} {orientation}.")


def duration(hours, minutes):  # format_duration of the legacy bot: "just now", "1 hour, 1 minute ago", "20 hours, 15 minutes ago"
    minutes %= 60
    h = f"{hours} hours" if hours > 1 else "1 hour" if hours == 1 else ""
    m = f", {minutes} minutes" if minutes > 1 else ", 1 minute" if minutes == 1 else ""
    return "just now" if hours == 0 and minutes == 0 else f"{h}{m} ago".lstrip(", ")


def rate_limit(frequency, current, others):  # others = [(id, created)], newest first; ages are relative to the current post
    lines = "".join(
        f"\n\n\t\t- [{pid}](https://redd.it/{pid}) ({duration(int((current - created) / 3600), int((current - created) / 60))})" for pid, created in others
    )
    next_time = datetime.fromtimestamp(others[-1][1] + 86400, timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    return (f"\n\n- **Rate limit reached.**\n\n\t- You cannot submit more than **{frequency} posts in a 24-hour period.** You submitted:"
            f"{lines}\n\n\t- Please wait until **{next_time} UTC** to submit again. ")  # a trailing space when incl_deleted is false


def source(hours=1):
    return f"\n\n- **Missing source in comments.** Timeout after {hours} hour{'' if hours == 1 else 's'}." + SOURCE_HELP


def repost(match_id, match_url, new_url, n=1):
    return ("\n\n- **Repost detected.**\n\n\t- Please avoid reposting images submitted in the last 6 months."
            f"\n\n\t\t- [Image #{n}]({new_url}) matched submission [{match_id}](https://redd.it/{match_id}) (2 months ago, [87.65% certainty]({match_url}))")


def url(name, host="i.redd.it", ext="jpg"):
    return f"https://{host}/{name}.{ext}"


# ---- the invented posts: id, author, seconds after BASE, flair, title, images, legacy db flags, Reddit side, comments
HOUR = 3600
P = {}  # id -> dict


def post(pid, author, at, flair_text, title, images, *, removed=0, deleted=0, approved=0, moderated=1, banned=None, approved_by=None, category=None,
         bot=None, bot_removed=False, source_at=None):
    comments = [{"author": author, "body": "Source: someone", "createdUtc": BASE + at + source_at, "removed": False}] if source_at is not None else []
    if bot:
        comments.append({"author": BOT, "body": bot, "createdUtc": BASE + at + 60, "removed": bot_removed})
    P[pid] = dict(id=pid, author=author, at=BASE + at, flair=flair_text, title=title, images=images, removed=removed, deleted=deleted, approved=approved,
                  moderated=moderated, banned=banned, approved_by=approved_by, category=category, comments=comments)


big, small = (1920, 1080), (1600, 1200)
u = {n: url(n) for n in ["aaa001", "aaa003", "aaa004a", "aaa004b", "aaa005", "aaa006", "aaa007", "aaa008", "aaa009", "aaa010", "aaa011", "aaa012",
                         "aaa013", "aaa014", "aaa015", "aaa016", "aaa017", "aaa019", "aaa020", "aaa021"]}
u["aaa002"] = url("aaa002", ext="png")
u["ext001"] = url("ext001", host="i.imgur.com")

# 1 a post that passes every rule; its author comments at once
post("1sam001", "alice", 0, "Desktop", "Misaki by someone [1920x1080]", [(u["aaa001"], *big)], source_at=600)
# 2 three rules fail: mismatch, size, aspect (the legacy comment of Appendix A1)
post("1sam002", "bob", 120, "Desktop", "Old art [1920x1080] enjoy", [(u["aaa002"], *small)], removed=1, banned=BOT,
     bot=comment(mismatch("1920x1080", "1600x1200"), bad_resolution("horizontal", "1920x1080", [(1, u["aaa002"], *small)]),
                 bad_aspect("horizontal", "of or wider than 16:10 (1.6:1)", [(1, u["aaa002"])], ["1.333"])))
# 3 flair rule: a vertical image under Desktop (Appendix A2)
post("1sam003", "carol", 240, "Desktop", "Phone wallpaper", [(u["aaa003"], 900, 1600)], removed=1, banned=BOT,
     bot=comment(flair("vertical", "Desktop", [u["aaa003"]])))
# 4 a gallery whose second image is small: the legacy bot numbers the failed images from 1 (D1: AWB says Image #2)
post("1sam004", "dave", 360, "Desktop", "Pack of two", [(u["aaa004a"], *big), (u["aaa004b"], 1280, 720)], removed=1, banned=BOT,
     bot=comment(bad_resolution("horizontal", "1920x1080", [(1, u["aaa004b"], 1280, 720)])))
# 5 to 7 three posts of one author in 2 hours, at most 2 allowed: the third is removed (Appendix A3 with 2 posts)
t5, t6, t7 = 480, 480 + HOUR, 480 + 2 * HOUR
post("1sam005", "erin", t5, "Desktop", "Erin one [1920x1080]", [(u["aaa005"], *big)], source_at=100)
post("1sam006", "erin", t6, "Desktop", "Erin two [1920x1080]", [(u["aaa006"], *big)], source_at=100)
post("1sam007", "erin", t7, "Desktop", "Erin three [1920x1080]", [(u["aaa007"], *big)], removed=1, banned=BOT,
     bot=comment(rate_limit(2, BASE + t7, [("1sam006", BASE + t6), ("1sam005", BASE + t5)])))
# 8 to 10 three posts of one author in 20 minutes after an outage: the legacy bot also counted the LATER posts (D2), so it removed all three
t8, t9, t10 = 9000, 9600, 10200
post("1sam008", "frank", t8, "Desktop", "Frank one [1920x1080]", [(u["aaa008"], *big)], removed=1, banned=BOT, source_at=100,
     bot=comment(rate_limit(2, BASE + t8, [("1sam010", BASE + t10), ("1sam009", BASE + t9)])))
post("1sam009", "frank", t9, "Desktop", "Frank two [1920x1080]", [(u["aaa009"], *big)], removed=1, banned=BOT, source_at=100,
     bot=comment(rate_limit(2, BASE + t9, [("1sam010", BASE + t10), ("1sam008", BASE + t8)])))
post("1sam010", "frank", t10, "Desktop", "Frank three [1920x1080]", [(u["aaa010"], *big)], removed=1, banned=BOT,
     bot=comment(rate_limit(2, BASE + t10, [("1sam009", BASE + t9), ("1sam008", BASE + t8)])))
# 11, 12 no source comment: removed at the deadline; a comment after the deadline is too late (Appendix A4)
post("1sam011", "gina", 12000, "Desktop", "Gina [1920x1080]", [(u["aaa011"], *big)], removed=1, banned=BOT, bot=comment(source()))
post("1sam012", "hank", 12600, "Desktop", "Hank [1920x1080]", [(u["aaa012"], *big)], removed=1, banned=BOT, bot=comment(source()), source_at=2 * HOUR)
# 13 a skip flair: the legacy bot does not look at the post
post("1sam013", "ivy", 13200, "Other", "Ivy", [(u["aaa013"], *small)], moderated=0)
# 14 to 17 the post had a state that the legacy bot saw (approved, removed by a mod, deleted) or got one later (removed by a mod after the bot passed it)
post("1sam014", "jack", 13800, "Desktop", "Jack", [(u["aaa014"], *small)], approved=1, approved_by="ModUser", moderated=0)
post("1sam015", "kate", 14400, "Desktop", "Kate", [(u["aaa015"], *small)], removed=1, banned="ModUser", moderated=0)
post("1sam016", "leo", 15000, "Desktop", "Leo [1920x1080]", [(u["aaa016"], *big)], removed=1, banned="ModUser", source_at=100)
post("1sam017", "mia", 15600, "Desktop", "Mia", [(u["aaa017"], *small)], deleted=1, category="deleted", moderated=0)
# 18 the image is on another host: the legacy bot downloaded it and removed the post for its size (D7: AWB does not check it)
post("1sam018", "nina", 16200, "Desktop", "Nina", [(u["ext001"], 1280, 720)], removed=1, banned=BOT,
     bot=comment(bad_resolution("horizontal", "1920x1080", [(1, u["ext001"], 1280, 720)])))
# 19, 20 repost: removed (report_only false), and reported (report_only true: the bot removes its own comment). 3.0 has no repost: the replay leaves them out
post("1sam019", "olga", 16800, "Desktop", "Olga [1920x1080]", [(u["aaa019"], *big)], removed=1, banned=BOT, source_at=100,
     bot=comment(repost("1sam001", u["aaa001"], u["aaa019"])))
post("1sam020", "pat", 17400, "Desktop", "Pat [1920x1080]", [(u["aaa020"], *big)], source_at=100, bot_removed=True,
     bot=comment(repost("1sam001", u["aaa001"], u["aaa020"])))
# 21 the author comments exactly at the deadline: a pass
post("1sam021", "quinn", 18000, "Desktop", "Quinn [1920x1080]", [(u["aaa021"], *big)], source_at=HOUR)

SCHEMA = """
CREATE TABLE submissions (id VARCHAR(20) PRIMARY KEY, subreddit VARCHAR(20) NOT NULL, author VARCHAR(20) NOT NULL,
  created_utc INT NOT NULL, removed BOOL NOT NULL DEFAULT FALSE, deleted BOOL NOT NULL DEFAULT FALSE,
  approved BOOL NOT NULL DEFAULT FALSE, moderated BOOL NOT NULL DEFAULT FALSE);
CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id VARCHAR(20) NOT NULL, url VARCHAR(255) NOT NULL,
  width INT NOT NULL, height INT NOT NULL, sift BLOB DEFAULT NULL);
"""


def main():
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA)
    for p in P.values():
        db.execute("INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                   (p["id"], SUB, p["author"], p["at"], p["removed"], p["deleted"], p["approved"], p["moderated"]))
        db.executemany("INSERT INTO images(submission_id, url, width, height) VALUES (?, ?, ?, ?)", [(p["id"], *i) for i in p["images"]])

    def query(sql):  # rows as `mysql -N -B` prints them
        return "".join("\t".join("NULL" if v is None else str(v) for v in row) + "\n" for row in db.execute(sql))

    def fetch(post_id):  # the Reddit side of a post
        p = P[post_id]
        return {"title": p["title"], "flair": p["flair"], "bannedBy": p["banned"], "approvedBy": p["approved_by"], "removedByCategory": p["category"],
                "comments": p["comments"]}

    anon = Anon()
    corpus, labels = capture(SUB, query, fetch, anon, BOT, posts=100, until=BASE + 10**6)
    out = ROOT / "test" / "fixtures" / "legacy-corpus-sample.json"
    text = corpus_text(corpus, anon)
    if "--check" in sys.argv[1:]:
        same = out.read_text() == text
        print(f"{out.relative_to(ROOT)} is {'what the tool writes' if same else 'NOT what the tool writes: run this script without --check'}")
        return 0 if same else 1
    out.write_text(text)
    print(summary(corpus, labels))
    print(f"wrote {out.relative_to(ROOT)}: {len(corpus['posts'])} posts")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
