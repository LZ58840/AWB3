import json
from types import SimpleNamespace

import pytest

from fetch_pairs import first_reddit_image, image, main, og_image, parse_cases, post_id

PNG = b"\x89PNG\r\n\x1a\n" + b"x" * 10
JPEG = b"\xff\xd8\xff" + b"y" * 10


def test_parse_cases_keeps_the_order_and_ignores_blank_lines():
    text = "# Case 1\n\nhttps://a/1\nhttps://a/2\n\n# Case 10\nhttps://b/1\n"
    assert parse_cases(text) == [("case-1", ["https://a/1", "https://a/2"]), ("case-10", ["https://b/1"])]


def test_parse_cases_refuses_a_url_before_the_first_case():
    with pytest.raises(SystemExit):
        parse_cases("https://a/1\n# Case 1\n")


def test_post_id_reads_reddit_links_and_ignores_other_hosts():
    assert post_id("https://www.reddit.com/r/Animewallpaper/comments/1vlnxyl/ranma_12/") == "1vlnxyl"
    assert post_id("https://old.reddit.com/r/x/comments/w2854w/t/") == "w2854w"
    assert post_id("https://redd.it/ut6k7z") == "ut6k7z"
    assert post_id("https://i.imgur.com/JHmiW7a.png") is None
    assert post_id("https://i.ibb.co/bW80L6G/98347988-bl2.png") is None


def test_first_reddit_image_takes_the_first_gallery_item_not_the_first_metadata_key():
    post = {"is_gallery": True, "gallery_data": {"items": [{"media_id": "b2"}, {"media_id": "a1"}]},
            "media_metadata": {"a1": {"status": "valid", "m": "image/png"}, "b2": {"status": "valid", "m": "image/jpg"}},
            "selftext": "", "url": "https://www.reddit.com/gallery/x"}
    assert first_reddit_image(post) == "https://i.redd.it/b2.jpg"


def test_first_reddit_image_takes_the_first_inline_image_of_a_text_post():
    post = {"is_gallery": False, "media_metadata": {"z9": {"status": "valid", "m": "image/png"}, "c3": {"status": "valid", "m": "image/jpeg"}},
            "selftext": "please upscale https://preview.redd.it/c3.jpeg?width=640 and https://preview.redd.it/z9.png", "url": "https://www.reddit.com/r/x/comments/p/t/"}
    assert first_reddit_image(post) == "https://i.redd.it/c3.jpeg"


def test_first_reddit_image_takes_the_link_of_a_link_post():
    assert first_reddit_image({"is_gallery": False, "media_metadata": None, "selftext": "", "url": "https://i.redd.it/abc.png"}) == "https://i.redd.it/abc.png"
    assert first_reddit_image({"selftext": "", "url": "https://imgur.com/VyWMLNl"}) == "https://imgur.com/VyWMLNl"


def test_first_reddit_image_refuses_a_text_post_without_an_image():
    with pytest.raises(ValueError):
        first_reddit_image({"selftext": "no image", "url": "https://www.reddit.com/r/x/comments/p/t/"})


def test_og_image_reads_the_meta_tag_and_drops_the_imgur_thumbnail_query():
    assert og_image('<meta property="og:image" content="https://i.ibb.co/x/a.png" />') == "https://i.ibb.co/x/a.png"
    assert og_image("<meta content='https://i.imgur.com/VyWMLNl.png?fb' property='og:image'>") == "https://i.imgur.com/VyWMLNl.png"
    assert og_image("<html></html>") is None


def test_image_follows_one_html_page_to_its_og_image_and_checks_the_magic_bytes():
    pages = {"https://imgur.com/VyWMLNl": ("https://imgur.com/VyWMLNl", b'<meta property="og:image" content="https://i.imgur.com/VyWMLNl.png?fb">'),
             "https://i.imgur.com/VyWMLNl.png": ("https://i.imgur.com/VyWMLNl.png", PNG)}
    assert image(pages.__getitem__, "https://imgur.com/VyWMLNl") == ("https://i.imgur.com/VyWMLNl.png", PNG, "png")
    with pytest.raises(ValueError, match="not an image"):
        image(lambda url: (url, b"<html>no meta</html>"), "https://ibb.co/x")


def test_image_refuses_the_imgur_placeholder_of_a_removed_image():
    with pytest.raises(ValueError, match="removed"):
        image(lambda url: ("https://i.imgur.com/removed.png", PNG), "https://i.imgur.com/gone.png")


def test_main_writes_numbered_files_and_a_manifest_per_case(tmp_path):
    cases = tmp_path / "cases.txt"
    cases.write_text("# Case 1\nhttps://www.reddit.com/r/x/comments/abc/t/\nhttps://i.ibb.co/q/b.jpg\n# Case 2\nhttps://i.imgur.com/gone.png\n")
    blobs = {"https://i.redd.it/abc.png": PNG, "https://i.ibb.co/q/b.jpg": JPEG}

    def get(url):
        if url not in blobs:
            raise ValueError("HTTP 404")
        return url, blobs[url]

    io = SimpleNamespace(get=get, reddit_post=lambda pid: {"selftext": "", "url": f"https://i.redd.it/{pid}.png"})
    out = tmp_path / "pairs"
    assert main([str(cases), "--out", str(out)], io=io, ignored=lambda path: True) == 1  # case 2 failed
    assert (out / "case-1" / "1.png").read_bytes() == PNG and (out / "case-1" / "2.jpg").read_bytes() == JPEG
    manifest = json.loads((out / "case-1" / "manifest.json").read_text())
    assert [(m["file"], m["source"], m["image"], m["bytes"]) for m in manifest] == [
        ("1.png", "https://www.reddit.com/r/x/comments/abc/t/", "https://i.redd.it/abc.png", len(PNG)),
        ("2.jpg", "https://i.ibb.co/q/b.jpg", "https://i.ibb.co/q/b.jpg", len(JPEG)),
    ]
    assert json.loads((out / "case-2" / "manifest.json").read_text())[0]["error"] == "HTTP 404"


def test_main_refuses_an_out_folder_that_git_does_not_ignore(tmp_path):
    cases = tmp_path / "cases.txt"
    cases.write_text("# Case 1\nhttps://i.ibb.co/q/b.jpg\n")
    with pytest.raises(SystemExit, match="does not ignore"):
        main([str(cases), "--out", str(tmp_path / "pairs")], io=SimpleNamespace(get=None, reddit_post=None), ignored=lambda path: False)
