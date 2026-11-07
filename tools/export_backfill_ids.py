"""Write the post IDs of the last N months, per subreddit, as text for the mod-only wiki pages awb-backfill-1..n.

Plan: OD2 (a), step 0.7. Run it 2 days after the 3.0-rc install, on a FRESH dump of the legacy database.

Input: a mysqldump file. The tool only reads the `submissions` table (other tables are skipped), so MySQL does not
need to run. Smallest dump (a few MB; run it on the legacy host; the password is read inside the container):

  docker exec awb_mysql sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump -u animewallpaperbot --single-transaction \\
      --no-tablespaces awb subreddits submissions' > awb-submissions.sql

A full dump with the `images` table also works (slower).

Output: <out>/<subreddit>/awb-backfill-1.txt, -2.txt, ... Paste each file into the wiki page of the same name in
THAT subreddit (r/<subreddit>/wiki/awb-backfill-1, ...), then set the page to "only mods may edit and view".
Page format: one post ID per line, newest first. Page 1 starts with `# until: <ISO UTC time>`: the newest post
time in the dump. Later pages hold only IDs. Each page is at most --page-bytes bytes.

No Reddit access and no credentials are needed.
"""
import argparse
import calendar
import re
from datetime import datetime, timezone
from pathlib import Path


def parse_submissions(lines):
    """Yield (id, subreddit, created_utc) for each row of the `submissions` table in a mysqldump."""
    cols = []
    in_create = False
    for n, line in enumerate(lines, 1):
        if line.startswith("CREATE TABLE `submissions`"):
            in_create, cols = True, []
        elif in_create:
            m = re.match(r"\s+`(\w+)`", line)
            if m:
                cols.append(m[1])
            else:
                in_create = False
        elif line.startswith("INSERT INTO `submissions`"):
            head, _, values = line.partition(" VALUES ")
            names = re.findall(r"`(\w+)`", head.partition("`submissions`")[2]) or cols
            if not {"id", "subreddit", "created_utc"} <= set(names):
                raise ValueError(f"line {n}: column order of `submissions` unknown (dump it with its CREATE TABLE)")
            for row in re.findall(r"\(([^()]*)\)", values):
                vals = [v.strip("'") for v in row.split(",")]
                f = dict(zip(names, vals))
                # ids and names go into wiki text and directory names, so only the legacy character sets pass
                if (len(vals) != len(names) or not re.fullmatch(r"[0-9a-z]+", f["id"])
                        or not re.fullmatch(r"[A-Za-z0-9_]+", f["subreddit"]) or not f["created_utc"].isdigit()):
                    raise ValueError(f"line {n}: unexpected row {row[:80]!r}")
                yield f["id"], f["subreddit"], int(f["created_utc"])


def add_months(dt, n):
    y, m = divmod(dt.year * 12 + dt.month - 1 + n, 12)
    return dt.replace(year=y, month=m + 1, day=min(dt.day, calendar.monthrange(y, m + 1)[1]))


def export_pages(rows, months, page_bytes):
    """Turn (id, subreddit, created_utc) rows into {subreddit: [wiki page text]}, newest posts first.

    Page 1 starts with `# until: <ISO UTC>`, the newest post time in the dump (all subreddits): the dump holds
    every post up to then. IDs are ASCII (parse_submissions checks), so len() is the byte size.
    """
    rows = list(rows)
    until = datetime.fromtimestamp(max(r[2] for r in rows), timezone.utc)
    cutoff = add_months(until, -months).timestamp()
    header = f"# until: {until:%Y-%m-%dT%H:%M:%SZ}\n"
    ids = {}
    for pid, sub, created in sorted(rows, key=lambda r: (-r[2], r[0])):
        if created >= cutoff:
            ids.setdefault(sub, []).append(pid + "\n")
    out = {}
    for sub, lines in ids.items():
        pages, page = [], header
        for line in lines:
            if len(page) + len(line) > page_bytes and page not in ("", header):
                pages.append(page)
                page = ""
            page += line
        out[sub] = pages + [page]
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump", help="mysqldump file of the legacy database")
    ap.add_argument("--out", required=True, help="output folder; one subfolder per subreddit is created in it")
    ap.add_argument("--months", type=int, default=6, choices=range(1, 9), metavar="N",
                    help="months back from the newest post (1-8, default 6 = repostMonths default)")
    ap.add_argument("--page-bytes", type=int, default=200_000, help="size limit of one wiki page (S7; default 200 KB)")
    args = ap.parse_args(argv)
    # latin-1 cannot fail on the binary BLOBs of a full dump; the ids and names that we read are ASCII
    with open(args.dump, encoding="latin-1", newline="\n") as f:
        rows = list(parse_submissions(f))
    if not rows:
        raise SystemExit(f"error: no rows of table `submissions` in {args.dump}")
    out = Path(args.out)
    for sub, pages in export_pages(rows, args.months, args.page_bytes).items():
        try:
            (out / sub).mkdir(parents=True)
        except FileExistsError:
            raise SystemExit(f"error: {out / sub} already exists; use a new --out folder") from None
        for i, page in enumerate(pages, 1):
            (out / sub / f"awb-backfill-{i}.txt").write_text(page)
        posts = sum(p.count("\n") for p in pages) - 1  # minus the "# until:" line
        print(f"{sub}: {posts} posts, {len(pages)} page(s) in {out / sub}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
