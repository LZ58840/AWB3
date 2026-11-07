import inspect
import subprocess
from dataclasses import replace
from types import SimpleNamespace

import pytest

import legacy_watch
from legacy_watch import MYSQL_CMD, Io, count_posts, docker_logs, hourly, main, modmail_subjects, mysql, once, self_test, send_modmail

NOW = 1795608000  # 2026-11-25T12:00:00Z
WORKER = "awb_moderator_worker"
SERVICE = "awb_moderator_service"
SETTINGS = "2026-11-25 11:55:00,000 [INFO] Detected update in settings page for r/Animewallpaper, reading [ModeratorService]"
ERR = "2026-11-25 11:30:02,114 [ERROR] Unknown error: unsupported operand type(s) for +: 'NoneType' and 'int' [ModeratorWorker]"


def make_io(logs=None, rows=None, lost=False):
    """Fakes: `logs` = {container: text}; `rows` = {subreddit: [(created_utc, moderated), ...]} = legacy `submissions` rows."""
    sent = []

    def count_posts(sub, since, until):
        hit = [m for t, m in (rows or {}).get(sub, []) if since <= t < until]
        return len(hit), sum(hit)

    io = Io(
        logs=lambda container, minutes: (logs or {}).get(container, ""),
        count_posts=count_posts,
        send_modmail=lambda sub, subject, body: sent.append((sub, subject, body)),
        modmail_subjects=lambda sub: ["AWB legacy watch self-test 00000000"] if lost else [s for x, s, _ in sent if x == sub],
        now=lambda: NOW,
        sleep=lambda seconds: None,
    )
    return io, sent


def test_unknown_error_in_the_worker_log_sends_a_modmail_to_each_subreddit():
    io, sent = make_io(logs={WORKER: "2026-11-25 11:00:00,000 [INFO] Processed submission 1q8z4mc [DataWorker]\n" + ERR + "\nTraceback (most recent call last):\n"})
    hourly(io, ["Animewallpaper", "AnimePhoneWallpapers"])
    subject = 'AWB legacy watch: "Unknown error" in the legacy worker log'
    assert [(s, subj) for s, subj, _ in sent] == [("Animewallpaper", subject), ("AnimePhoneWallpapers", subject)]
    body = sent[0][2]
    assert "1 line(s)" in body and "2026-11-25 11:00" in body and "2026-11-25 12:00" in body  # the count and the time window
    assert "unsupported operand" not in body and ERR not in body  # a log line can hold SQL or user data: it stays on the legacy host


def test_clean_log_and_moderated_posts_send_nothing():
    io, sent = make_io(logs={WORKER: "[INFO] Processed submission 1q8z4mc [DataWorker]\n"}, rows={"Animewallpaper": [(NOW - 3 * 3600, 1), (NOW - 4 * 3600, 0)]})
    assert hourly(io, ["Animewallpaper"]) == [] and sent == []


def test_six_hours_without_a_moderated_post_while_new_posts_exist_sends_a_modmail():
    io, sent = make_io(rows={"Animewallpaper": [(NOW - 5 * 3600, 0), (NOW - 3 * 3600, 0)], "AnimePhoneWallpapers": [(NOW - 3 * 3600, 1)]})
    assert hourly(io, ["Animewallpaper", "AnimePhoneWallpapers"]) == [("Animewallpaper", "AWB legacy watch: no post moderated for 6 h")]
    assert "2 post(s)" in sent[0][2]


def test_silence_ignores_old_posts_and_posts_that_the_bot_has_had_no_time_for():
    # 7 h old (outside the window) and 30 min old (the legacy bot may wait up to its source-comment timeout, 2 h at most)
    io, sent = make_io(rows={"Animewallpaper": [(NOW - 7 * 3600, 0), (NOW - 30 * 60, 0)]})
    assert hourly(io, ["Animewallpaper"]) == [] and sent == []


def run_once(logs, rows):
    io, _ = make_io(logs=logs, rows={"Animewallpaper": rows})
    return {name: ok for name, ok, _ in once(io, "Animewallpaper", 15)}


def test_once_passes_the_three_cut_over_checks():
    assert run_once({SERVICE: SETTINGS, WORKER: "[INFO] Removed submission 1q8z4mc from r/Animewallpaper\n"}, [(NOW - 600, 1), (NOW - 300, 0)]) == {
        "settings page update seen": True,
        "no Unknown error": True,
        "new posts moderated": True,
    }


def test_once_fails_each_check_on_its_own():
    ok = [(NOW - 600, 1)]
    assert not run_once({SERVICE: SETTINGS.replace("Animewallpaper", "OtherSub"), WORKER: ""}, ok)["settings page update seen"]
    assert run_once({SERVICE: SETTINGS.replace("Animewallpaper", "animewallpaper"), WORKER: ""}, ok)["settings page update seen"]
    assert not run_once({SERVICE: SETTINGS, WORKER: ERR}, ok)["no Unknown error"]
    assert not run_once({SERVICE: SETTINGS}, [(NOW - 600, 0)])["new posts moderated"]
    assert not run_once({SERVICE: SETTINGS}, [])["new posts moderated"]  # no new post yet: cannot say PASS


def test_self_test_passes_when_the_alert_is_read_back_from_modmail():
    io, sent = make_io()
    ok, detail = self_test(io, "Animewallpaper")
    assert ok and [(sub, subject.startswith("AWB legacy watch self-test ")) for sub, subject, _ in sent] == [("Animewallpaper", True)]


def test_self_test_fails_when_only_an_older_alert_is_in_modmail():
    ok, detail = self_test(make_io(lost=True)[0], "Animewallpaper")
    assert not ok and "not found" in detail


def test_self_test_fails_with_the_reason_when_sending_fails():
    def refuse(sub, subject, body):
        raise RuntimeError("403 insufficient_scope")

    ok, detail = self_test(replace(make_io()[0], send_modmail=refuse), "Animewallpaper")
    assert not ok and "RuntimeError: 403 insufficient_scope" in detail


def test_count_posts_counts_posts_and_moderated_posts_in_the_half_open_window_of_one_subreddit(legacy_db):
    query = legacy_db(submissions=[
        ("a", "Animewallpaper", "u", 100, 0, 0, 0, 1), ("b", "Animewallpaper", "u", 150, 0, 0, 0, 0),
        ("c", "Animewallpaper", "u", 200, 0, 0, 0, 1), ("d", "Other", "u", 150, 0, 0, 0, 1),
    ])
    assert count_posts("Animewallpaper", 100, 200, query) == (2, 1)
    assert count_posts("Animewallpaper", 300, 400, query) == (0, 0)


def test_count_posts_refuses_a_subreddit_name_that_is_not_a_name():
    with pytest.raises(ValueError):
        count_posts("x'; DROP TABLE submissions; --", 0, 1, lambda sql: "0\t0\n")


def test_docker_and_mysql_run_without_a_shell_and_logs_include_stderr(monkeypatch):
    calls = []

    def run(cmd, **kw):
        calls.append((cmd, kw))
        return SimpleNamespace(stdout="out\n", stderr="err: Unknown error\n")

    monkeypatch.setattr(subprocess, "run", run)
    assert docker_logs("awb_moderator_worker", 15) == "out\nerr: Unknown error\n"  # Python logging writes to stderr
    assert calls[0][0] == ["docker", "logs", "--since", "15m", "awb_moderator_worker"]
    assert mysql("SELECT 1;") == "out\n"
    assert calls[1][0][:4] == ["docker", "exec", "-i", "awb_mysql"] and calls[1][1]["input"] == "SELECT 1;"  # SQL goes by stdin
    assert all(kw["check"] for _, kw in calls)


class FakeReddit:
    """Same names and keyword-only arguments as PRAW 8 (the next test checks them against the installed PRAW)."""

    def __init__(self):
        self.messages = []
        self.modmail = SimpleNamespace(conversations=self.conversations)

    def subreddit(self, name):
        self.name = name
        return self

    def message(self, *, subject, message):
        self.messages.append((self.name, subject, message))

    def conversations(self, *, state=None, limit=None):
        return [SimpleNamespace(subject=f"{state} one"), SimpleNamespace(subject=f"{state} two")]


def test_modmail_functions_use_the_praw_calls():
    reddit = FakeReddit()
    send_modmail(reddit, "Animewallpaper", "subject", "body")
    assert reddit.messages == [("Animewallpaper", "subject", "body")]
    assert modmail_subjects(reddit, "Animewallpaper") == ["all one", "all two", "mod one", "mod two"]


def test_praw_has_the_calls_that_the_modmail_functions_make():
    from praw.models import Subreddit
    from praw.models.reddit.subreddit.modmail import Modmail

    keyword_only = inspect.Parameter.KEYWORD_ONLY
    message = inspect.signature(Subreddit.message).parameters
    assert message["subject"].kind == message["message"].kind == keyword_only
    conversations = inspect.signature(Modmail.conversations).parameters
    assert conversations["state"].kind == keyword_only and "generator_kwargs" in conversations  # limit goes there


def test_main_once_prints_pass_or_fail_per_check_and_exits_1_when_one_fails(capsys):
    io, _ = make_io(logs={SERVICE: SETTINGS, WORKER: ERR}, rows={"Animewallpaper": [(NOW - 600, 1)]})
    assert main(["--once", "--sub", "Animewallpaper"], io) == 1
    assert capsys.readouterr().out.splitlines() == [
        "PASS settings page update seen: awb_moderator_service log, last 15 min",
        "FAIL no Unknown error: 1 line(s) in the awb_moderator_worker log, last 15 min",
        "PASS new posts moderated: 1 of 1 posts of the last 15 min have moderated = TRUE",
    ]
    assert main(["--once", "--sub", "Animewallpaper", "--minutes", "30"], make_io(logs={SERVICE: SETTINGS}, rows={"Animewallpaper": [(NOW - 1500, 1)]})[0]) == 0


def test_main_self_test_prints_pass_or_fail(capsys):
    assert main(["--self-test", "--sub", "Animewallpaper"], make_io()[0]) == 0
    assert capsys.readouterr().out.startswith("PASS self-test: ")
    assert main(["--self-test", "--sub", "Animewallpaper"], make_io(lost=True)[0]) == 1
    assert capsys.readouterr().out.startswith("FAIL self-test: ")


def test_main_hourly_is_silent_when_all_is_well_and_prints_each_alert_it_sent(capsys):
    assert main(["--sub", "Animewallpaper"], make_io(rows={"Animewallpaper": [(NOW - 3 * 3600, 1)]})[0]) == 0
    assert capsys.readouterr().out == ""
    assert main(["--sub", "Animewallpaper", "--sub", "AnimePhoneWallpapers"], make_io(logs={WORKER: ERR})[0]) == 0
    assert capsys.readouterr().out.splitlines() == [
        'ALERT r/Animewallpaper: AWB legacy watch: "Unknown error" in the legacy worker log',
        'ALERT r/AnimePhoneWallpapers: AWB legacy watch: "Unknown error" in the legacy worker log',
    ]


def test_main_needs_a_subreddit_name_and_one_mode(capsys):
    for argv in (["--once"], ["--sub", "x'y"], ["--once", "--self-test", "--sub", "a"], ["--self-test", "--sub", "a", "--sub", "b"]):
        with pytest.raises(SystemExit) as e:
            main(argv, make_io()[0])
        assert e.value.code == 2


def test_the_reddit_client_does_not_ask_pypi_for_updates_on_every_cron_run(monkeypatch):
    import praw

    made = []
    monkeypatch.setattr(praw, "Reddit", lambda **kwargs: made.append(kwargs) or "client")
    legacy_watch.reddit.cache_clear()
    try:
        assert legacy_watch.reddit() == "client"
    finally:
        legacy_watch.reddit.cache_clear()
    assert made == [{"user_agent": legacy_watch.USER_AGENT, "check_for_updates": False}]  # credentials: praw.ini or environment


def test_the_mysql_password_goes_by_environment_not_by_argument():
    script = MYSQL_CMD[-1]  # the sh -c script that runs in the container: an argument shows in `ps`
    assert 'MYSQL_PWD="$MYSQL_PASSWORD"' in script and " -p" not in script
