"""Create the additive Intent-First Adaptive Action Engine schema."""
from app.db.session import init_db

if __name__ == "__main__":
    init_db()
    print("Intent engine schema is current.")
