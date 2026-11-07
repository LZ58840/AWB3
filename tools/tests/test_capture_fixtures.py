import json
import shlex
import subprocess
from types import SimpleNamespace

import pytest
from prawcore.exceptions import NotFound

from capture_fixtures import (
    DB_CMD, Anon, anonymize_config, build_post, capture, corpus_text, fetch_config, fetch_post, git_ignores, group_rows, leaks, legacy_decision, main,
    repost_labels, scrub, summary, tags_only,
)

# Expected texts are copied from the legacy inventory (.omc/research/awb-legacy-requirements.md, Appendix A3 and A5).
A3_RATE_LIMIT = (
    "Thank you for contributing to r/Animewallpaper! Unfortunately, your submission was removed for the following reason:\n\n"
    "- **Rate limit reached.**\n\n\t- You cannot submit more than **4 posts in a 24-hour period.** You submitted:\n\n"
    "\t\t- [p4](https://redd.it/p4) (just now)\n\n\t\t- [p3](https://redd.it/p3) (1 hour, 1 minute ago)\n\n"
    "\t- Please wait until **2024-12-04 15:20:00 UTC** to submit again. Deleted submissions will still be counted towards the rate limit.\n\n"
    "*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit]"
    "(https://reddit.com/message/compose/?to=/r/Animewallpaper) if you have any questions or concerns.*"
)
A5_REPOST = (
    "Thank you for contributing to r/Animewallpaper! Unfortunately, your submission was removed for the following reason:\n\n"
    "- **Repost detected.**\n\n\t- Please avoid reposting images submitted in the last 6 months.\n\n"
    "\t\t- [Image #1](https://i.redd.it/new.png) matched submission [1abcde](https://redd.it/1abcde) "
    "(2 months ago, [87.65% certainty](https://i.redd.it/old.png))\n\n"
    "*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit]"
    "(https://reddit.com/message/compose/?to=/r/Animewallpaper) if you have any questions or concerns.*"
)


def test_anon_gives_the_same_pseudonym_for_the_same_value_and_keeps_the_url_host_and_extension():
    anon = Anon()
    assert anon.user("alice") == anon.user("alice") == "user00001"
    assert anon.user("bob") == "user00002"
    assert anon.user("AutoModerator") == "AutoModerator" and anon.user("carl") == "user00003"  # a public bot account: the replay config names it too
    assert anon.post("1abcde") == anon.post("1abcde") == "p00001"  # still looks like a Reddit post ID: 6 chars of 0-9a-z
    assert anon.image("https://i.redd.it/aaa.png") == "https://i.redd.it/i00001.png"
    assert anon.image("https://i.imgur.com/bbb.jpg?x=1") == "https://i.imgur.com/i00002.jpg"
    assert anon.image("https://i.redd.it/aaa.png") == "https://i.redd.it/i00001.png"


def test_scrub_replaces_post_ids_and_image_urls_and_nothing_else():
    anon = Anon()
    assert scrub(A5_REPOST, anon) == A5_REPOST.replace("1abcde", "p00001").replace("new.png", "i00001.png").replace("old.png", "i00002.png")
    assert scrub(A3_RATE_LIMIT, anon) == A3_RATE_LIMIT.replace("[p4](https://redd.it/p4)", "[p00002](https://redd.it/p00002)").replace(
        "[p3](https://redd.it/p3)", "[p00003](https://redd.it/p00003)"
    )


def test_scrub_does_not_touch_an_id_that_is_also_a_word_elsewhere_in_the_text():
    text = "[attack](https://redd.it/attack) The attack was a repost."
    assert scrub(text, Anon()) == "[p00001](https://redd.it/p00001) The attack was a repost."


def test_anon_shifts_every_time_by_one_offset_and_by_nothing_without_one():
    anon = Anon(offset=-365 * 86400)
    assert anon.time(1790000000) == 1790000000 - 365 * 86400
    assert anon.clock("2026-11-25 12:00:00") == "2025-11-25 12:00:00"  # the time text of a rate-limit comment
    assert Anon().time(5) == 5 and Anon().clock("2026-11-25 12:00:00") == "2026-11-25 12:00:00"


def test_scrub_shifts_the_time_that_a_rate_limit_comment_names_and_keeps_the_ages():
    shifted = scrub(A3_RATE_LIMIT, Anon(offset=-20 * 3600))
    assert "**2024-12-03 19:20:00 UTC**" in shifted  # was 2024-12-04 15:20:00
    assert "(just now)" in shifted and "(1 hour, 1 minute ago)" in shifted  # intervals do not change


def test_tags_only_keeps_what_the_title_regex_of_the_legacy_bot_matches():
    # rules.py:41-68 regex: [(\[]\s?([0-9]{3,})\s?[Xx×]\s?([0-9]{3,})\s?[)\]]
    assert tags_only("[Genshin] Raiden by artist [3840x2160] (1920 × 1080] [1080p] (12x34)") == "[3840x2160] (1920 × 1080]"
    assert tags_only("No tags here") == ""


A2_FLAIR = (
    "Thank you for contributing to r/Animewallpaper! Unfortunately, your submission was removed for the following reason:\n\n"
    "- Vertical images are not allowed under the **Desktop** flair.\n\n\t- [Image #1](https://i.redd.it/v1.jpg) is vertical.\n\n"
    "*I am a bot, and this action was performed automatically. Please [contact the moderators of this subreddit]"
    "(https://reddit.com/message/compose/?to=/r/Animewallpaper) if you have any questions or concerns.*"
)


def comment(author, body="hello", created=0, removed=False):
    return {"author": author, "body": body, "createdUtc": created, "removed": removed}


def test_group_rows_makes_one_post_per_id_with_its_images_in_order():
    rows = [
        ["1abc001", "alice", "1790000000", "1", "https://i.redd.it/a.jpg", "3840", "2160"],
        ["1abc001", "alice", "1790000000", "1", "https://i.redd.it/b.png", "1920", "1080"],
        ["1abc002", "bob", "1790000500", "0", "NULL", "NULL", "NULL"],  # a post with no stored image
    ]
    assert group_rows(rows) == [
        {"id": "1abc001", "author": "alice", "createdUtc": 1790000000, "moderated": True,
         "images": [{"url": "https://i.redd.it/a.jpg", "width": 3840, "height": 2160}, {"url": "https://i.redd.it/b.png", "width": 1920, "height": 1080}]},
        {"id": "1abc002", "author": "bob", "createdUtc": 1790000500, "moderated": False, "images": []},
    ]


def test_legacy_decision_reads_the_sticky_comment_of_the_bot():
    assert legacy_decision([comment("someone"), comment("AnimewallpaperBot", A2_FLAIR)], "AnimewallpaperBot") == ("remove", A2_FLAIR)
    assert legacy_decision([comment("animewallpaperbot", A2_FLAIR, removed=True)], "AnimewallpaperBot") == ("report", A2_FLAIR)  # report-only: bot hides its comment
    assert legacy_decision([comment("someone", A2_FLAIR), comment("AnimewallpaperBot", "Thanks for the source")], "AnimewallpaperBot") == ("none", None)
    assert legacy_decision([comment(None)], "AnimewallpaperBot") == ("none", None)  # deleted account


def test_build_post_anonymizes_and_keeps_what_the_rules_read():
    anon = Anon()
    db = {"id": "1abc001", "author": "alice", "createdUtc": 1790000000, "moderated": True,
          "images": [{"url": "https://i.redd.it/v1.jpg", "width": 900, "height": 1600}]}
    fetched = {"title": "[Art] Raiden by someone (900x1600)", "flair": "Desktop", "bannedBy": "AnimewallpaperBot", "approvedBy": None, "removedByCategory": "moderator",
               "comments": [comment("bob", created=1790000050), comment("alice", created=1790000120), comment("alice", created=1790000100), comment("AnimewallpaperBot", A2_FLAIR)]}
    assert build_post(db, fetched, anon, "AnimewallpaperBot") == {
        "id": "p00001", "author": "user00001", "createdUtc": 1790000000, "title": "(900x1600)", "flair": "Desktop",
        "images": [{"url": "https://i.redd.it/i00001.jpg", "width": 900, "height": 1600}],
        "sourceCommentUtc": 1790000100,
        "legacy": {"action": "remove", "comment": A2_FLAIR.replace("v1.jpg", "i00001.jpg"), "moderated": True, "removedBy": "awb", "approved": False, "deleted": False},
    }
    other = build_post({**db, "id": "1abc002"}, {**fetched, "bannedBy": "SomeMod", "approvedBy": "OtherMod", "removedByCategory": "deleted", "comments": []}, anon, "AnimewallpaperBot")
    assert other["legacy"] == {"action": "none", "comment": None, "moderated": True, "removedBy": "mod", "approved": True, "deleted": True}
    assert other["sourceCommentUtc"] is None


def test_build_post_shifts_the_times_of_the_post_and_of_the_source_comment_by_the_same_offset():
    db = {"id": "1abc001", "author": "alice", "createdUtc": 1790000000, "moderated": True, "images": []}
    gone = {"title": "", "flair": None, "bannedBy": None, "approvedBy": None, "removedByCategory": None}
    post = build_post(db, {**gone, "comments": [comment("alice", created=1790000100)]}, Anon(offset=-1000), "AnimewallpaperBot")
    assert (post["createdUtc"], post["sourceCommentUtc"]) == (1789999000, 1789999100)  # the 100 s between them stay
    assert build_post(db, {**gone, "comments": []}, Anon(offset=-1000), "AnimewallpaperBot")["sourceCommentUtc"] is None


def test_repost_labels_give_one_pair_per_match_line_with_the_outcome_for_the_mods():
    two = A5_REPOST.replace(
        "(2 months ago, [87.65% certainty](https://i.redd.it/old.png))",
        "(2 months ago, [87.65% certainty](https://i.redd.it/old.png))\n\n\t\t- [Image #2](https://i.redd.it/new2.jpg) matched submission "
        "[1zzzzz](https://redd.it/1zzzzz) (just now, [76.12% certainty](https://i.redd.it/old2.jpg))",
    )
    removed = {"comments": [comment("AnimewallpaperBot", two)], "bannedBy": "AnimewallpaperBot", "approvedBy": None}
    first = {"subreddit": "Animewallpaper", "postId": "1xyz999", "createdUtc": 1790000000, "imageIndex": 1, "imageUrl": "https://i.redd.it/new.png",
             "matchedPostId": "1abcde", "matchedImageUrl": "https://i.redd.it/old.png", "certainty": 87.65, "age": "2 months ago", "outcome": "kept"}
    second = {**first, "imageIndex": 2, "imageUrl": "https://i.redd.it/new2.jpg", "matchedPostId": "1zzzzz", "matchedImageUrl": "https://i.redd.it/old2.jpg",
              "certainty": 76.12, "age": "just now"}
    assert repost_labels("Animewallpaper", "1xyz999", 1790000000, removed, "AnimewallpaperBot") == [first, second]
    reversed_ = {**removed, "bannedBy": None, "approvedBy": "SomeMod"}
    assert [r["outcome"] for r in repost_labels("Animewallpaper", "1xyz999", 1790000000, reversed_, "AnimewallpaperBot")] == ["reversed", "reversed"]
    neither = {**removed, "bannedBy": None}
    assert {r["outcome"] for r in repost_labels("Animewallpaper", "1xyz999", 1790000000, neither, "AnimewallpaperBot")} == {"unknown"}


def test_repost_labels_are_empty_when_the_bot_comment_has_no_repost_section():
    other = {"comments": [comment("AnimewallpaperBot", A2_FLAIR)], "bannedBy": "AnimewallpaperBot", "approvedBy": None}
    assert repost_labels("Animewallpaper", "1xyz999", 1790000000, other, "AnimewallpaperBot") == []
    assert repost_labels("Animewallpaper", "1xyz999", 1790000000, {"comments": [], "bannedBy": None, "approvedBy": None}, "AnimewallpaperBot") == []


def repost_comment(new_url, matched_id, matched_url):
    return A5_REPOST.replace("https://i.redd.it/new.png", new_url).replace("1abcde", matched_id).replace("https://i.redd.it/old.png", matched_url)


def test_capture_builds_the_corpus_and_the_labels_from_legacy_rows_and_reddit_data(legacy_db, capsys):
    db = legacy_db(
        submissions=[  # id, subreddit, author, created_utc, removed, deleted, approved, moderated
            ("1old001", "Animewallpaper", "carol", 500, 1, 0, 0, 1),  # older than the newest 2, but removed by the bot: a label candidate
            ("1abc001", "Animewallpaper", "alice", 1000, 0, 0, 1, 1),  # approved by a mod after the bot removed it: label "reversed"
            ("1abc002", "Animewallpaper", "bob", 2000, 1, 0, 0, 0),  # removed by a mod before the bot looked: no label; Reddit gives 404
            ("1abc003", "Animewallpaper", "alice", 2200, 0, 0, 0, 1),
            ("1new001", "Animewallpaper", "dave", 3000, 0, 0, 0, 1),  # newer than `until`: the legacy bot may not be done with it
            ("1oth001", "Other", "erin", 1500, 0, 0, 0, 1),
        ],
        images=[("1abc001", "https://i.redd.it/aaa.png", 1920, 1080), ("1abc001", "https://i.redd.it/bbb.png", 900, 1600), ("1old001", "https://i.redd.it/ccc.jpg", 800, 600)],
    )
    gone = {"title": "x", "flair": None, "bannedBy": None, "approvedBy": None, "removedByCategory": None, "comments": []}
    fetched = {
        "1abc001": {**gone, "title": "Art (1920x1080)", "flair": "Desktop", "approvedBy": "SomeMod",
                    "comments": [comment("AnimewallpaperBot", repost_comment("https://i.redd.it/aaa.png", "1old001", "https://i.redd.it/ccc.jpg"))]},
        "1abc003": gone,
        "1old001": {**gone, "bannedBy": "AnimewallpaperBot", "comments": [comment("AnimewallpaperBot", repost_comment("https://i.redd.it/ccc.jpg", "1prev00", "https://i.redd.it/prev.jpg"))]},
    }
    calls = []

    def fetch(post_id):
        calls.append(post_id)
        return fetched.get(post_id)  # None = Reddit says 404

    anon = Anon()
    corpus, labels = capture("Animewallpaper", db, fetch, anon, "AnimewallpaperBot", posts=3, until=2500)
    assert [p["createdUtc"] for p in corpus["posts"]] == [1000, 2200]  # the newest 3 up to `until`, oldest first; the 404 post is left out
    assert corpus["subreddit"] == "Animewallpaper" and corpus["posts"][0]["legacy"]["action"] == "remove"
    assert [(r["postId"], r["outcome"]) for r in labels] == [("1old001", "kept"), ("1abc001", "reversed")]  # real IDs: this file stays private
    assert calls == ["1abc001", "1abc002", "1abc003", "1old001"]  # each post is fetched once
    assert leaks(corpus, anon) == []
    assert "1abc002" in capsys.readouterr().err


def test_capture_shifts_the_times_of_the_corpus_and_keeps_the_real_times_in_the_private_labels(legacy_db):
    db = legacy_db(submissions=[("1abc001", "Animewallpaper", "alice", 1790000000, 1, 0, 0, 1), ("1abc002", "Animewallpaper", "bob", 1790003600, 0, 0, 0, 1)])
    fetched = {
        "1abc001": {"title": "", "flair": None, "bannedBy": "AnimewallpaperBot", "approvedBy": None, "removedByCategory": None,
                    "comments": [comment("AnimewallpaperBot", repost_comment("https://i.redd.it/aaa.png", "1old001", "https://i.redd.it/ccc.jpg"))]},
        "1abc002": {"title": "", "flair": None, "bannedBy": None, "approvedBy": None, "removedByCategory": None, "comments": [comment("bob", created=1790003700)]},
    }
    corpus, labels = capture("Animewallpaper", db, fetched.get, Anon(offset=-31536000), "AnimewallpaperBot", posts=5, until=1800000000)
    assert [(p["createdUtc"], p["sourceCommentUtc"]) for p in corpus["posts"]] == [(1758464000, None), (1758467600, 1758467700)]  # intervals: 3600 s and 100 s
    assert [label["createdUtc"] for label in labels] == [1790000000]  # the private file keeps the real time


def test_leaks_finds_a_real_name_or_id_as_a_whole_word_in_any_string_of_the_corpus():
    anon = Anon()
    anon.user("alice"), anon.user("art"), anon.post("1abc001"), anon.image("https://i.redd.it/aaa.png")
    clean = {"subreddit": "S", "posts": [{"author": "user00001", "id": "p00001", "images": [{"url": "https://i.redd.it/i00001.png"}],
                                          "legacy": {"comment": "Respect the artist. [p00001](https://redd.it/p00001)"}}]}
    assert leaks(clean, anon) == []  # "art" is only a part of "artist": not a hit
    dirty = {"posts": [{"author": "alice", "legacy": {"comment": "thanks u/Alice\n\nsee https://redd.it/1abc001/ and https://i.redd.it/aaa.png?x=1"}}]}
    assert leaks(dirty, anon) == ["alice", "1abc001", "https://i.redd.it/aaa.png"]  # name (whole string and in a text), ID in a link, URL
    assert leaks({"c": "fullname t3_1abc001"}, anon) == ["1abc001"]  # an ID after an underscore is still the ID


def test_corpus_text_refuses_to_serialize_a_corpus_that_still_has_a_real_name():
    anon = Anon()
    anon.user("alice")
    assert json.loads(corpus_text({"subreddit": "S", "posts": [{"author": "user00001"}]}, anon))["posts"] == [{"author": "user00001"}]
    for post in ({"author": "alice"}, {"legacy": {"comment": "thanks u/alice"}}):
        with pytest.raises(SystemExit, match="alice"):
            corpus_text({"subreddit": "S", "posts": [post]}, anon)


def test_summary_counts_the_legacy_actions_and_the_rules_in_the_comments_and_warns_below_200_posts():
    posts = [{"legacy": {"action": a, "comment": c}} for a, c in [("remove", A2_FLAIR), ("remove", A5_REPOST), ("none", None)]]
    labels = [{"outcome": "kept"}, {"outcome": "reversed"}, {"outcome": "kept"}]
    line = summary({"subreddit": "Animewallpaper", "posts": posts}, labels)
    assert line == (
        "Animewallpaper: 3 posts | legacy: none 1, remove 2 | rules in comments: flair 1, repost 1 | repost label pairs: kept 2, reversed 1"
        " | WARNING: plan 0.6 wants at least 200 posts"
    )
    assert "WARNING" not in summary({"subreddit": "S", "posts": posts * 70}, [])


class FakeReddit:
    """The few PRAW 8 names that fetch_post uses: reddit.submission(id), submission.comments.replace_more(limit=), iteration."""

    def __init__(self, submissions):
        self.submissions = submissions

    def submission(self, post_id):
        return self.submissions[post_id]


class Forest(list):
    def replace_more(self, *, limit):
        self.limit = limit  # limit=0: drop the "load more" stubs without more requests


def test_fetch_post_copies_what_the_corpus_needs_into_plain_data():
    forest = Forest([
        SimpleNamespace(author=SimpleNamespace(name="bob"), body="source: x", created_utc=1790000050.0, banned_by=None),
        SimpleNamespace(author=None, body="[deleted]", created_utc=1790000060.0, banned_by="SomeMod"),  # deleted account
    ])
    post = SimpleNamespace(title="Art (1920x1080)", link_flair_text="Desktop", banned_by=None, approved_by="SomeMod", removed_by_category=None, comments=forest)
    assert fetch_post(FakeReddit({"1abc001": post}), "1abc001") == {
        "title": "Art (1920x1080)", "flair": "Desktop", "bannedBy": None, "approvedBy": "SomeMod", "removedByCategory": None,
        "comments": [{"author": "bob", "body": "source: x", "createdUtc": 1790000050, "removed": False},
                     {"author": None, "body": "[deleted]", "createdUtc": 1790000060, "removed": True}],
    }
    assert forest.limit == 0


def test_fetch_post_gives_none_when_reddit_says_404():
    class Missing:
        @property
        def comments(self):
            raise NotFound(SimpleNamespace(status_code=404))

    assert fetch_post(FakeReddit({"1gone01": Missing()}), "1gone01") is None


@pytest.fixture
def repo(tmp_path):
    """A git repository that ignores private/, as the real one ignores test/fixtures/private/."""
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    (tmp_path / ".gitignore").write_text("private/\n")
    return tmp_path


LIVE_PAGE = "# mods only\nenabled: true\nflairs:\n  Desktop: horizontal\n  Other: skip\nexcept_authors:\n- AutoModerator\n- alice\n- zed\n"
REPOST_REMOVAL = {"title": "Art [1920x1080]", "flair": "Desktop", "bannedBy": "AnimewallpaperBot", "approvedBy": None, "removedByCategory": "moderator",
                  "comments": [comment("AnimewallpaperBot", repost_comment("https://i.redd.it/aaa.png", "1old001", "https://i.redd.it/ccc.jpg"))]}


def one_post_db(legacy_db):
    return legacy_db(submissions=[("1abc001", "Animewallpaper", "alice", 1790000000, 1, 0, 0, 1)], images=[("1abc001", "https://i.redd.it/aaa.png", 1920, 1080)])


def test_main_writes_corpus_config_and_private_labels_with_one_set_of_pseudonyms(legacy_db, repo, capsys):
    io = (one_post_db(legacy_db), lambda post_id: REPOST_REMOVAL, lambda sub: LIVE_PAGE)
    assert main(["--sub", "Animewallpaper", "--out", str(repo)], io, offset=-1000) == 0
    corpus = json.loads((repo / "legacy-corpus-animewallpaper.json").read_text())
    assert (corpus["posts"][0]["author"], corpus["posts"][0]["createdUtc"]) == ("user00001", 1789999000) and "alice" not in json.dumps(corpus)
    config = (repo / "legacy-config-animewallpaper.yaml").read_text()
    assert config.endswith("except_authors:\n- AutoModerator\n- user00001\n- user00002\n")  # alice is user00001 here too: the replay matches them
    labels = json.loads((repo / "private" / "legacy-repost-labels-animewallpaper.json").read_text())
    assert [(r["postId"], r["matchedPostId"], r["outcome"], r["createdUtc"]) for r in labels] == [("1abc001", "1old001", "kept", 1790000000)]  # real: private
    assert capsys.readouterr().out.splitlines()[-1].startswith("Animewallpaper: 1 posts | legacy: remove 1 | rules in comments: repost 1 | repost label pairs: kept 1")


def test_main_moves_all_times_by_one_random_offset_of_one_to_three_years_back(legacy_db, repo):
    db = legacy_db(submissions=[("1abc001", "Animewallpaper", "alice", 1790000000, 1, 0, 0, 1), ("1abc002", "Animewallpaper", "bob", 1790003600, 0, 0, 0, 1)])
    assert main(["--sub", "Animewallpaper", "--out", str(repo)], (db, lambda post_id: REPOST_REMOVAL, lambda sub: None)) == 0
    first, second = [p["createdUtc"] for p in json.loads((repo / "legacy-corpus-animewallpaper.json").read_text())["posts"]]
    assert second - first == 3600 and -3 * 365 * 86400 <= first - 1790000000 <= -365 * 86400


def test_main_writes_no_config_for_a_subreddit_without_the_wiki_page(legacy_db, repo, capsys):
    assert main(["--sub", "Animewallpaper", "--out", str(repo)], (one_post_db(legacy_db), lambda post_id: REPOST_REMOVAL, lambda sub: None)) == 0
    assert not (repo / "legacy-config-animewallpaper.yaml").exists() and "no wiki page awb" in capsys.readouterr().err


def test_main_refuses_before_any_request_when_git_does_not_ignore_the_private_folder(tmp_path):
    def never(*args):
        raise AssertionError("must not run")

    (tmp_path / "plain").mkdir()
    subprocess.run(["git", "init", "-q", str(tmp_path / "no-ignore")], check=True)  # a repo with no .gitignore
    for out in (tmp_path / "plain", tmp_path / "no-ignore"):  # not a repo, and a repo that does not ignore
        with pytest.raises(SystemExit, match="does not ignore"):
            main(["--sub", "Animewallpaper", "--out", str(out)], (never, never, never))


def test_git_ignores_follows_git_check_ignore_also_for_a_folder_that_is_not_there_yet(repo, tmp_path):
    assert git_ignores(repo / "private" / "labels.json") and not git_ignores(repo / "corpus.json")
    assert not git_ignores(tmp_path.parent / "outside-any-repo.json")


def test_main_needs_valid_subreddit_names(capsys):
    for argv in ([], ["--sub", "x'y"]):
        with pytest.raises(SystemExit) as e:
            main(argv, (None, None, None))
        assert e.value.code == 2


def test_anonymize_config_gives_except_authors_the_pseudonyms_of_the_corpus_and_drops_the_comments():
    anon = Anon()
    anon.user("alice")  # a corpus author comes first
    assert anonymize_config(LIVE_PAGE, anon, "Animewallpaper") == (
        "# Anonymized copy of the live `awb` wiki page of r/Animewallpaper (tools/capture_fixtures.py): usernames except AutoModerator are the pseudonyms"
        " of the corpus; comments are dropped.\n"
        "enabled: true\nflairs:\n  Desktop: horizontal\n  Other: skip\nexcept_authors:\n- AutoModerator\n- user00001\n- user00002\n"
    )
    assert anon.user("zed") == "user00002"
    for bad in ("- just\n- a list\n", "except_authors: alice\n"):
        with pytest.raises(SystemExit, match="r/Animewallpaper"):
            anonymize_config(bad, Anon(), "Animewallpaper")


class Page:
    def __init__(self, content=None):
        self.content = content

    @property
    def content_md(self):
        if self.content is None:
            raise NotFound(SimpleNamespace(status_code=404))
        return self.content


def test_fetch_config_reads_the_awb_wiki_page_and_gives_none_when_there_is_none():
    pages = {"Animewallpaper": {"awb": Page(LIVE_PAGE)}, "Empty": {"awb": Page()}}
    reddit = SimpleNamespace(subreddit=lambda name: SimpleNamespace(wiki=pages[name]))
    assert fetch_config(reddit, "Animewallpaper") == LIVE_PAGE
    assert fetch_config(reddit, "Empty") is None


def test_the_default_db_command_keeps_the_mysql_password_out_of_the_arguments():
    script = shlex.split(DB_CMD)[-1]  # an argument shows in `ps`
    assert 'MYSQL_PWD="$MYSQL_PASSWORD"' in script and " -p" not in script
