"""Load a schema + a D1 SQL dump into the local SQLite DB.

Used by the weekly market-cap workflow to reconstruct the transactions table
from a `wrangler d1 export` dump before computing company market caps.

    python -m scraper.load_dump schema.sql dump.sql
"""
import sqlite3
import sys

from app.db import DB_PATH


def main(argv):
    db_path = DB_PATH.replace("sqlite:///", "")
    conn = sqlite3.connect(db_path)
    for path in argv:
        with open(path) as fh:
            conn.executescript(fh.read())
    conn.commit()
    n = conn.execute("SELECT count(*) FROM transactions").fetchone()[0]
    print(f"Loaded {n} transactions into {db_path}")


if __name__ == "__main__":
    main(sys.argv[1:])
