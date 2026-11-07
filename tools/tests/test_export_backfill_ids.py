from datetime import datetime, timezone
from pathlib import Path

import pytest

import export_backfill_ids
from export_backfill_ids import add_months, export_pages, main, parse_submissions

# Shape of `mysqldump awb subreddits submissions` from MySQL 8.0 (legacy db/setup: LZ58840/AnimewallpaperBot deployments/setup.sql).
DUMP = """\
-- MySQL dump 10.13  Distrib 8.0.29, for Linux (x86_64)
--
-- Host: localhost    Database: awb
-- ------------------------------------------------------
DROP TABLE IF EXISTS `submissions`;
CREATE TABLE `submissions` (
  `id` varchar(20) NOT NULL,
  `subreddit` varchar(20) NOT NULL,
  `author` varchar(20) NOT NULL,
  `created_utc` int NOT NULL,
  `removed` tinyint(1) NOT NULL DEFAULT '0',
  `deleted` tinyint(1) NOT NULL DEFAULT '0',
  `approved` tinyint(1) NOT NULL DEFAULT '0',
  `moderated` tinyint(1) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`),
  KEY `subreddit` (`subreddit`),
  CONSTRAINT `submissions_ibfk_1` FOREIGN KEY (`subreddit`) REFERENCES `subreddits` (`name`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
LOCK TABLES `submissions` WRITE;
INSERT INTO `submissions` VALUES ('1abc001','Animewallpaper','alice',1790000000,0,0,0,1),('1abc002','Animewallpaper','bob_2',1790000100,1,0,0,1);
UNLOCK TABLES;
"""


def test_parse_submissions_gives_id_subreddit_created_utc():
    assert list(parse_submissions(DUMP.splitlines())) == [
        ("1abc001", "Animewallpaper", 1790000000),
        ("1abc002", "Animewallpaper", 1790000100),
    ]


def test_other_tables_are_skipped():
    dump = DUMP + (
        "INSERT INTO `subreddits` VALUES ('Animewallpaper','{\"enabled\": true, \"x\": [1,(2)]}',1790000100,1789999999);\n"
        "INSERT INTO `images` VALUES (1,'1abc001','https://i.redd.it/a.jpg',1920,1080,0x80049512),(2,'1abc001','https://i.redd.it/b.jpg',1,2,NULL);\n"
    )
    assert [r[0] for r in parse_submissions(dump.splitlines())] == ["1abc001", "1abc002"]


def test_column_order_comes_from_create_table():
    dump = (
        "CREATE TABLE `submissions` (\n  `created_utc` int NOT NULL,\n  `id` varchar(20) NOT NULL,\n"
        "  `subreddit` varchar(20) NOT NULL,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB;\n"
        "INSERT INTO `submissions` VALUES (1790000000,'1abc001','Animewallpaper');\n"
    )
    assert list(parse_submissions(dump.splitlines())) == [("1abc001", "Animewallpaper", 1790000000)]


def test_insert_with_own_column_list_needs_no_create_table():
    dump = "INSERT INTO `submissions` (`id`, `created_utc`, `subreddit`) VALUES ('1abc001',1790000000,'Animewallpaper');\n"
    assert list(parse_submissions(dump.splitlines())) == [("1abc001", "Animewallpaper", 1790000000)]


def test_unknown_column_order_is_an_error():
    dump = "INSERT INTO `submissions` VALUES ('1abc001','Animewallpaper','alice',1790000000,0,0,0,1);\n"
    with pytest.raises(ValueError, match="column"):
        list(parse_submissions(dump.splitlines()))


def test_row_that_does_not_fit_the_columns_is_an_error():
    dump = DUMP.replace("('1abc002','Animewallpaper','bob_2',1790000100,1,0,0,1)", "('1ABC002','Animewallpaper','bob_2',1790000100,1,0,0,1)")
    with pytest.raises(ValueError, match="line 20"):
        list(parse_submissions(dump.splitlines()))


def ts(iso):
    return int(datetime.fromisoformat(iso).timestamp())


UNTIL = ts("2026-11-25T12:00:00+00:00")


def test_add_months_keeps_the_day_or_clamps_to_month_end():
    d = datetime(2026, 8, 31, 12, tzinfo=timezone.utc)
    assert add_months(d, -6) == datetime(2026, 2, 28, 12, tzinfo=timezone.utc)
    assert add_months(d, -8) == datetime(2025, 12, 31, 12, tzinfo=timezone.utc)


def test_page_one_starts_with_until_then_ids_newest_first_per_subreddit():
    rows = [
        ("1aaaaa1", "Animewallpaper", UNTIL - 100),
        ("1aaaaa2", "Animewallpaper", UNTIL),
        ("1bbbbb1", "AnimePhoneWallpapers", UNTIL - 5),
    ]
    assert export_pages(rows, months=6, page_bytes=200_000) == {
        "Animewallpaper": ["# until: 2026-11-25T12:00:00Z\n1aaaaa2\n1aaaaa1\n"],
        "AnimePhoneWallpapers": ["# until: 2026-11-25T12:00:00Z\n1bbbbb1\n"],
    }


def test_only_the_last_n_calendar_months_before_until_are_listed():
    cutoff = ts("2026-05-25T12:00:00+00:00")
    rows = [("1old0001", "S", cutoff - 1), ("1edge001", "S", cutoff), ("1new0001", "S", UNTIL)]
    pages = export_pages(rows, months=6, page_bytes=200_000)
    assert pages["S"][0].split("\n")[1:-1] == ["1new0001", "1edge001"]


def test_pages_split_at_the_byte_limit_and_only_page_one_has_the_header():
    ids = [f"1aaaaa{i:x}" for i in range(12)]
    rows = [(pid, "S", UNTIL - i) for i, pid in enumerate(ids)]
    header = "# until: 2026-11-25T12:00:00Z\n"
    limit = len(header) + 2 * 8  # page 1 fits the header and 2 ids; the other pages fit 5 ids
    pages = export_pages(rows, months=6, page_bytes=limit)["S"]
    assert [p.count("\n") for p in pages] == [3, 5, 5]
    assert pages[0].startswith(header) and not any(p.startswith("#") for p in pages[1:])
    assert all(len(p.encode()) <= limit for p in pages)
    assert "".join(pages).replace(header, "").split() == ids


def test_cli_writes_a_folder_per_subreddit_and_reads_a_dump_with_binary_blobs(tmp_path, capsys):
    dump = tmp_path / "dump.sql"
    dump.write_bytes(DUMP.encode() + b"INSERT INTO `images` VALUES (1,'1abc001','u',1,2,_binary '\x80\xff\x00 \\' ');\n")
    assert main([str(dump), "--out", str(tmp_path / "out")]) == 0
    page = tmp_path / "out" / "Animewallpaper" / "awb-backfill-1.txt"
    assert page.read_text() == "# until: 2026-09-21T14:15:00Z\n1abc002\n1abc001\n"
    assert "Animewallpaper: 2 posts, 1 page" in capsys.readouterr().out


def test_cli_refuses_a_dump_without_rows_and_an_existing_output_folder(tmp_path):
    empty = tmp_path / "empty.sql"
    empty.write_text("-- nothing\n")
    with pytest.raises(SystemExit, match="no rows"):
        main([str(empty), "--out", str(tmp_path / "out")])
    dump = tmp_path / "dump.sql"
    dump.write_text(DUMP)
    (tmp_path / "out" / "Animewallpaper").mkdir(parents=True)
    with pytest.raises(SystemExit, match="already exists"):
        main([str(dump), "--out", str(tmp_path / "out")])


def test_backfill_sample_fixture_is_the_tool_output(tmp_path):
    """test/fixtures/backfill-sample.txt is the contract of the TypeScript backfill: it must equal what the tool writes.

    To renew it: python tools/export_backfill_ids.py tools/tests/data/legacy-dump-sample.sql --out <new folder>,
    then copy <folder>/Animewallpaper/awb-backfill-1.txt to test/fixtures/backfill-sample.txt.
    """
    root = Path(__file__).resolve().parents[2]
    assert main([str(root / "tools/tests/data/legacy-dump-sample.sql"), "--out", str(tmp_path)]) == 0
    assert (tmp_path / "Animewallpaper" / "awb-backfill-1.txt").read_text() == (root / "test/fixtures/backfill-sample.txt").read_text()


def test_the_dump_command_in_the_help_keeps_the_mysql_password_out_of_ps():
    assert 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump' in export_backfill_ids.__doc__ and '-p"' not in export_backfill_ids.__doc__
