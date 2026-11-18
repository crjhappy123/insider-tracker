"""Load a schema + a D1 SQL dump into the local SQLite DB.

Used by the leaderboard / market-cap / A-share workflows to reconstruct the
current remote state from a `wrangler d1 export` dump before recomputing.

    python -m scraper.load_dump schema.sql dump.sql
"""
import sqlite3
import sys

from app.db import DB_PATH

# Reported after loading, so a workflow log shows what actually came down.
_SUMMARY_TABLES = (
    "transactions", "leaderboard", "cn_transactions", "cn_leaderboard", "yt_videos",
    "yt_macro_reports",
)


def main(argv):
    db_path = DB_PATH.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    for path in argv:
        with open(path) as fh:
            conn.executescript(fh.read())
    conn.commit()
    counts = []
    for table in _SUMMARY_TABLES:
        try:
            n = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        except sqlite3.OperationalError:
            continue  # table not in this dump
        counts.append(f"{n} {table}")
    print(f"Loaded {', '.join(counts)} into {db_path}")


if __name__ == "__main__":
    main(sys.argv[1:])
