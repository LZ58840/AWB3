"""Watch the legacy AnimewallpaperBot until the Data API closes on Jan 12, 2027 (plan: 7.7, Phase 0.10, Phase 5 cut-over 1 step 4).

Run it on the LEGACY host. Three modes:

  legacy_watch.py --sub Animewallpaper --sub AnimePhoneWallpapers
      The hourly cron run. Sends a modmail to each subreddit when (a) the log of container awb_moderator_worker has
      "Unknown error" in the last hour, or (b) none of the posts that the legacy db got 2 to 6 hours ago has
      moderated = TRUE. It repeats every hour while the cause lasts. It prints only when it sends an alert, so cron
      mails you (with MAILTO set) only then. The modmail holds only a count and a time window, never log text: read the
      lines on the host with `docker logs --since 1h awb_moderator_worker`.
  legacy_watch.py --self-test --sub Animewallpaper
      Sends a test alert and looks for it in the modmail of the subreddit. Prints PASS or FAIL. Run it once before
      you add the cron entry.
  legacy_watch.py --once --sub Animewallpaper [--minutes 15]
      The 3 cut-over checks: the legacy moderator service has read the new wiki page, the worker log has no
      "Unknown error", and new posts have moderated = TRUE. Prints PASS or FAIL for each; exit code 1 if one fails.

Needs on the host: Python 3.10+, `pip install -r tools/requirements.txt` (a venv), and a user that may run
`docker logs` and `docker exec` (containers awb_moderator_worker, awb_moderator_service, awb_mysql). The MySQL password
is read inside awb_mysql from its own environment; it is not needed here.

Reddit credentials (not needed for --once): this tool stores none. PRAW reads them from environment variables or from
praw.ini (for example ~/.config/praw.ini, section [DEFAULT], chmod 600):
  praw_client_id, praw_client_secret, praw_refresh_token   (legacy .env names: AWB_CLIENT_ID, AWB_CLIENT_SECRET, AWB_TOKEN)
  or, for a script app: praw_client_id, praw_client_secret, praw_username, praw_password
The account must moderate the subreddit with the Mail permission. A refresh token needs the scopes
identity, modmail and read. If --self-test prints FAIL with a scope or permission error, make a new token.
PRAW also reads ./praw.ini of the current folder: run the tool from a folder that only you control.
"""

import argparse
import functools
import re
import secrets
import subprocess
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Callable

WORKER = "awb_moderator_worker"
SERVICE = "awb_moderator_service"
# The mysql client runs inside the legacy container, which has the password in its own environment. MYSQL_PWD, not -p:
# an argument shows in `ps`.
MYSQL_CMD = ["docker", "exec", "-i", "awb_mysql", "sh", "-c", 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u animewallpaperbot -N -B awb']
USER_AGENT = "script:awb3-legacy-watch:v1 (by u/AnimewallpaperBot)"
# shortcut: the legacy db has no "moderated at" time, so the post time stands in for it. A post that the bot skips (skip flair,
# except_authors) never gets moderated = TRUE, so a quiet subreddit with only such posts can give a false alert. There is no
# alert memory either: a lasting problem sends a modmail every hour. Upgrade: a state file with the last alert time.
SILENT_HOURS = 6
# The legacy bot may hold a post up to its source-comment timeout before it sets moderated (RabbitMQ ack timeout: 2 h).
GRACE_HOURS = 2


@dataclass
class Io:
    """Everything that touches the outside world, so that pytest can give fakes."""

    logs: Callable[[str, int], str]  # (container, minutes) -> docker log text
    count_posts: Callable[[str, int, int], tuple]  # (subreddit, from_utc, to_utc) -> (posts, posts with moderated = TRUE)
    send_modmail: Callable[[str, str, str], None]  # (subreddit, subject, body)
    modmail_subjects: Callable[[str], list]  # subreddit -> subjects of recent modmail conversations
    now: Callable[[], float] = time.time
    sleep: Callable[[float], None] = time.sleep


def unknown_errors(log):
    return [line for line in log.splitlines() if "Unknown error" in line]


def utc(ts):
    return datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%d %H:%M")


def hourly(io, subs):
    """The cron run: modmail each subreddit when the legacy bot looks broken. Returns the (subreddit, subject) sent."""
    sent = []
    errors = unknown_errors(io.logs(WORKER, 60))
    now = int(io.now())
    since, until = now - SILENT_HOURS * 3600, now - GRACE_HOURS * 3600
    for sub in subs:
        alerts = []
        if errors:
            # only the count: a log line can hold SQL or user data, and modmail is not the place for it
            alerts.append(('"Unknown error" in the legacy worker log', f"{len(errors)} line(s) with \"Unknown error\" in the log of {WORKER} between {utc(now - 3600)} and {utc(now)} UTC. Read them on the legacy host: docker logs --since 1h {WORKER}"))
        posts, moderated = io.count_posts(sub, since, until)
        if posts and not moderated:
            alerts.append((f"no post moderated for {SILENT_HOURS} h", f"{posts} post(s) of r/{sub} were created between {utc(since)} and {utc(until)} UTC. None has moderated = TRUE in the legacy database."))
        for subject, body in alerts:
            io.send_modmail(sub, f"AWB legacy watch: {subject}", body)
            sent.append((sub, f"AWB legacy watch: {subject}"))
    return sent


def once(io, sub, minutes):
    """The 3 checks of cut-over 1 step 4 (plan, Phase 5). Returns [(check, ok, detail)]."""
    seen = re.search(re.escape(f"Detected update in settings page for r/{sub},"), io.logs(SERVICE, minutes), re.I)
    errors = unknown_errors(io.logs(WORKER, minutes))
    now = int(io.now())
    posts, moderated = io.count_posts(sub, now - minutes * 60, now)
    return [
        ("settings page update seen", bool(seen), f"{SERVICE} log, last {minutes} min"),
        ("no Unknown error", not errors, f"{len(errors)} line(s) in the {WORKER} log, last {minutes} min"),
        ("new posts moderated", moderated > 0, f"{moderated} of {posts} posts of the last {minutes} min have moderated = TRUE"),
    ]


def self_test(io, sub, tries=5, delay=3):
    """Send a test alert, then look for it in the modmail of the subreddit. Returns (ok, detail)."""
    subject = f"AWB legacy watch self-test {secrets.token_hex(4)}"
    try:
        io.send_modmail(sub, subject, "Test alert from tools/legacy_watch.py --self-test. Nothing to do; you can archive it.")
        for _ in range(tries):
            io.sleep(delay)
            if subject in io.modmail_subjects(sub):
                return True, f"test alert sent and read back from the modmail of r/{sub}"
    except Exception as e:  # scope, permission or network errors are the likely causes; the owner needs the text
        return False, f"{type(e).__name__}: {e}"
    return False, f"test alert sent, but not found in the modmail of r/{sub} after {tries * delay} s"


def sub_name(name):
    if not re.fullmatch(r"[A-Za-z0-9_]{1,21}", name):
        raise ValueError(name)
    return name


def docker_logs(container, minutes):
    p = subprocess.run(["docker", "logs", "--since", f"{minutes}m", container], capture_output=True, text=True, errors="replace", check=True)
    return p.stdout + p.stderr  # Python logging writes to stderr


def mysql(sql):
    return subprocess.run(MYSQL_CMD, input=sql, capture_output=True, text=True, check=True).stdout


def count_posts(sub, since, until, query=mysql):
    """(posts, posts with moderated = TRUE) with created_utc in [since, until) in the legacy db."""
    sub_name(sub)  # the name goes into the SQL text
    posts, moderated = query(
        f"SELECT COUNT(*), COUNT(CASE WHEN moderated THEN 1 END) FROM submissions"
        f" WHERE subreddit = '{sub}' AND created_utc >= {since} AND created_utc < {until};"
    ).split()
    return int(posts), int(moderated)


def send_modmail(reddit, sub, subject, body):
    # Reddit refuses a private message to /r/<sub> (USER_DOESNT_EXIST on 'to'), so the subreddit opens a modmail
    # conversation with the bot account. Reddit most likely puts it in the Mod Discussions tab (a moderator is the recipient).
    reddit.subreddit(sub).modmail.create(subject=subject, body=body, recipient=reddit.user.me())


def modmail_subjects(reddit, sub):
    modmail = reddit.subreddit(sub).modmail
    return [c.subject for state in ("all", "mod") for c in modmail.conversations(state=state, limit=25)]


@functools.cache
def reddit():
    import praw  # late, so that --help and --once need neither praw nor Reddit credentials

    return praw.Reddit(user_agent=USER_AGENT, check_for_updates=False)  # no PyPI call and no version notice in cron mail


def real_io():
    return Io(
        logs=docker_logs,
        count_posts=count_posts,
        send_modmail=lambda sub, subject, body: send_modmail(reddit(), sub, subject, body),
        modmail_subjects=lambda sub: modmail_subjects(reddit(), sub),
    )


def main(argv=None, io=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sub", action="append", required=True, type=sub_name, help="subreddit name; repeat it in the hourly run")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--once", action="store_true", help="run the 3 cut-over checks")
    mode.add_argument("--self-test", action="store_true", help="send a test alert and read it back from modmail")
    ap.add_argument("--minutes", type=int, default=15, help="window of the --once checks (default 15)")
    args = ap.parse_args(argv)
    if (args.once or args.self_test) and len(args.sub) != 1:
        ap.error("--once and --self-test take exactly one --sub")
    io = io or real_io()
    if args.self_test:
        ok, detail = self_test(io, args.sub[0])
        print(f"{'PASS' if ok else 'FAIL'} self-test: {detail}")
        return 0 if ok else 1
    if args.once:
        results = once(io, args.sub[0], args.minutes)
        for check, ok, detail in results:
            print(f"{'PASS' if ok else 'FAIL'} {check}: {detail}")
        return 0 if all(ok for _, ok, _ in results) else 1
    for sub, subject in hourly(io, args.sub):
        print(f"ALERT r/{sub}: {subject}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
