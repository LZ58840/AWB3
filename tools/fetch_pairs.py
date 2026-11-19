"""Download the owner's same-image cases for S9 (plan: OD8): the first image of each Reddit post, imgur link or ibb.co link.

  fetch_pairs.py CASES_FILE [--out test/fixtures/private/pairs]

CASES_FILE lists the cases, one URL per line, under a header line "# Case <name>":

  # Case 1
  https://www.reddit.com/r/Animewallpaper/comments/1vlnxyl/...
  https://i.imgur.com/JHmiW7a.png

It writes <out>/case-<name>/<n>.<ext> (n = the line order in the case, ext from the file bytes) and
<out>/case-<name>/manifest.json: [{"file", "source", "image", "bytes", "sha256"}], or {"source", "error"} for a URL that
failed. The other URLs still download. The exit status is 1 when a URL failed.

What it downloads from each URL:
  Reddit post (reddit.com/.../comments/<id>/..., redd.it/<id>): the first image of the gallery, else the first image in
      the post text, else the link of the post (which can be an imgur or ibb.co link). Always the original file
      (i.redd.it), not a preview.
  A direct image link (i.redd.it, i.imgur.com, i.ibb.co): the file.
  A page (imgur.com/<id>, ibb.co/<id>): the image that the page names in its og:image tag.

The images are the work of real users and the Reddit links name real posts: the tool refuses to write unless git ignores
--out (the default is in test/fixtures/private/, which .gitignore lists). Do not commit or upload them.

Reddit credentials: the same as capture_fixtures.py (this tool stores none). PRAW reads them from environment variables
or from praw.ini: praw_client_id, praw_client_secret, praw_refresh_token (legacy .env names: AWB_CLIENT_ID,
AWB_CLIENT_SECRET, AWB_TOKEN). Scope: read. PRAW also reads ./praw.ini of the current folder: run the tool from a folder
that only you control. Python 3.10+ and `pip install -r tools/requirements.txt` (PRAW and requests).
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

USER_AGENT = "script:awb3-fetch-pairs:v1 (by u/AnimewallpaperBot)"
MAX_BYTES = 64 * 1024 * 1024  # an 8K PNG is about 50 MB at most
MAGIC = {b"\x89PNG\r\n\x1a\n": "png", b"\xff\xd8\xff": "jpg", b"GIF8": "gif"}
CASE = re.compile(r"#\s*Case\s+(\S+)", re.I)
POST = re.compile(r"^(?:(?:www\.|old\.|new\.)?reddit\.com/r/[^/]+/comments/|redd\.it/)([0-9a-z]+)")
OG = re.compile(r"""<meta\s[^>]*property=["']og:image["'][^>]*>""", re.I)
CONTENT = re.compile(r"""content=["']([^"']+)["']""", re.I)
EXT = {"image/png": "png", "image/jpg": "jpg", "image/jpeg": "jpeg", "image/gif": "gif", "image/webp": "webp"}


def parse_cases(text):
    cases = []
    for line in map(str.strip, text.splitlines()):
        if not line:
            continue
        header = CASE.fullmatch(line)
        if header:
            cases.append((f"case-{header.group(1)}", []))
        elif not cases:
            raise SystemExit(f"error: the URL {line} comes before the first '# Case' line")
        else:
            cases[-1][1].append(line)
    return cases


def post_id(url):
    parts = urlsplit(url)
    match = POST.match(parts.netloc + parts.path)
    return match.group(1) if match else None


def first_reddit_image(post):
    """The URL of the first image of a post (plain data of the PRAW submission). ValueError when it has none."""
    meta = post.get("media_metadata") or {}

    def original(media_id):  # i.redd.it has the original file; the preview URLs of media_metadata are smaller copies
        return f"https://i.redd.it/{media_id}.{EXT[meta[media_id]['m']]}"

    if post.get("is_gallery"):
        valid = [item["media_id"] for item in post["gallery_data"]["items"] if meta.get(item["media_id"], {}).get("status") == "valid"]
        if valid:
            return original(valid[0])
    inline = sorted((post["selftext"].find(key), key) for key, value in meta.items() if value.get("status") == "valid" and key in post["selftext"])
    if inline:
        return original(inline[0][1])
    if post_id(post["url"]) is None and "/gallery/" not in post["url"]:
        return post["url"]
    raise ValueError("the post has no image")


def og_image(html):
    tag = OG.search(html)
    content = tag and CONTENT.search(tag.group(0))
    if not content:
        return None
    url = content.group(1).replace("&amp;", "&")
    parts = urlsplit(url)
    return urlunsplit(parts._replace(query="")) if parts.netloc == "i.imgur.com" else url  # imgur's ?fb is a smaller copy


def kind(body):
    if body[:4] == b"RIFF" and body[8:12] == b"WEBP":
        return "webp"
    return next((ext for magic, ext in MAGIC.items() if body.startswith(magic)), None)


def image(get, url):
    """(image URL, bytes, extension) for an image URL or for a page with an og:image tag. get(url) -> (final URL, bytes)."""
    for _ in range(2):  # the URL, then at most one og:image
        final, body = get(url)
        if urlsplit(final).path.endswith("/removed.png"):  # imgur redirects a deleted image to this placeholder
            raise ValueError("the image was removed from its host")
        ext = kind(body)
        if ext:
            return final, body, ext
        url = og_image(body.decode("utf-8", "replace"))
        if not url:
            break
    raise ValueError(f"not an image, and no og:image tag: {final}")


def fetch(io, source):
    pid = post_id(source)
    return image(io.get, first_reddit_image(io.reddit_post(pid)) if pid else source)


def git_ignores(path):  # the same check as capture_fixtures.git_ignores
    path = Path(path).resolve()
    here = next(folder for folder in path.parents if folder.exists())
    try:
        return subprocess.run(["git", "check-ignore", "-q", "--", str(path)], cwd=here, capture_output=True).returncode == 0
    except FileNotFoundError:
        return False


def real_io():
    import praw  # late, so that --help needs no praw
    import requests

    reddit = praw.Reddit(user_agent=USER_AGENT, check_for_updates=False)
    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT

    def get(url):
        if urlsplit(url).scheme != "https":
            raise ValueError(f"not an https URL: {url}")
        with session.get(url, timeout=60, stream=True) as resp:
            if resp.status_code != 200:
                raise ValueError(f"HTTP {resp.status_code} for {url}")
            body = resp.raw.read(MAX_BYTES + 1, decode_content=True)
            if len(body) > MAX_BYTES:
                raise ValueError(f"larger than {MAX_BYTES} bytes: {url}")
            return resp.url, body

    def reddit_post(pid):
        post = reddit.submission(pid)
        return {"is_gallery": getattr(post, "is_gallery", False), "gallery_data": getattr(post, "gallery_data", None),
                "media_metadata": getattr(post, "media_metadata", None), "selftext": post.selftext, "url": post.url}

    return argparse.Namespace(get=get, reddit_post=reddit_post)


def main(argv=None, io=None, ignored=git_ignores):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", type=Path, help="the file with the cases")
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parents[1] / "test" / "fixtures" / "private" / "pairs")
    args = ap.parse_args(argv)
    cases = parse_cases(args.cases.read_text())
    if not ignored(args.out / "manifest.json"):
        raise SystemExit(f"error: git does not ignore {args.out}, so the images could be committed. Use a folder in test/fixtures/private/. Nothing was downloaded.")
    io = io or real_io()
    status = 0
    for name, urls in cases:
        folder = args.out / name
        folder.mkdir(parents=True, exist_ok=True)
        manifest = []
        for n, source in enumerate(urls, 1):
            try:
                url, body, ext = fetch(io, source)
            except Exception as error:  # one bad URL must not stop the others; the manifest and stderr show it
                manifest.append({"source": source, "error": str(error)})
                print(f"{name} #{n}: FAILED {source}: {error}", file=sys.stderr)
                status = 1
                continue
            (folder / f"{n}.{ext}").write_bytes(body)
            manifest.append({"file": f"{n}.{ext}", "source": source, "image": url, "bytes": len(body), "sha256": hashlib.sha256(body).hexdigest()})
            print(f"{name} #{n}: {n}.{ext} ({len(body)} bytes) from {url}")
        (folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return status


if __name__ == "__main__":
    raise SystemExit(main())
