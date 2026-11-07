import sqlite3
import sys
from pathlib import Path

import pytest

# The tools are single files in tools/; python -I (isolated mode) does not put that folder on sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

LEGACY_SCHEMA = """
CREATE TABLE submissions (id VARCHAR(20) PRIMARY KEY, subreddit VARCHAR(20) NOT NULL, author VARCHAR(20) NOT NULL,
  created_utc INT NOT NULL, removed BOOL NOT NULL DEFAULT FALSE, deleted BOOL NOT NULL DEFAULT FALSE,
  approved BOOL NOT NULL DEFAULT FALSE, moderated BOOL NOT NULL DEFAULT FALSE);
CREATE TABLE images (id INTEGER PRIMARY KEY AUTOINCREMENT, submission_id VARCHAR(20) NOT NULL, url VARCHAR(255) NOT NULL,
  width INT NOT NULL, height INT NOT NULL, sift BLOB DEFAULT NULL);
"""


@pytest.fixture
def legacy_db():
    """Fake legacy database: the tables of deployments/setup.sql (LZ58840/AnimewallpaperBot) in sqlite.

    legacy_db(submissions=[(id, subreddit, author, created_utc, removed, deleted, approved, moderated)],
              images=[(submission_id, url, width, height)]) returns query(sql): rows as `mysql -N -B` prints them.
    """
    dbs = []

    def make(submissions=(), images=()):
        db = sqlite3.connect(":memory:")
        dbs.append(db)
        db.executescript(LEGACY_SCHEMA)
        db.executemany("INSERT INTO submissions VALUES (?, ?, ?, ?, ?, ?, ?, ?)", submissions)
        db.executemany("INSERT INTO images(submission_id, url, width, height) VALUES (?, ?, ?, ?)", images)
        return lambda sql: "".join("\t".join("NULL" if v is None else str(v) for v in row) + "\n" for row in db.execute(sql))

    yield make
    for db in dbs:
        db.close()
