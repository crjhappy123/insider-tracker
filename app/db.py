"""Database engine and session setup."""
import os

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker

# SQLite lives next to the project root; override with DATABASE_URL if needed.
DB_PATH = os.environ.get(
    "DATABASE_URL",
    f"sqlite:///{os.path.join(os.path.dirname(os.path.dirname(__file__)), 'insider.db')}",
)

engine = create_engine(DB_PATH, echo=False, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, future=True)


class Base(DeclarativeBase):
    pass


def init_db() -> None:
    """Create tables if they do not exist."""
    from app import models  # noqa: F401  (register models on Base)

    Base.metadata.create_all(engine)
