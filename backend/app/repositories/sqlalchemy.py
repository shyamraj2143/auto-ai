from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.chat import Chat
from app.models.user import User


class SQLAlchemyUserRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_email(self, email: str) -> User | None:
        return self.db.scalar(select(User).where(User.email == email.strip().lower()))

    def get_by_mobile(self, mobile: str) -> User | None:
        return self.db.scalar(select(User).where(User.mobile == mobile.strip()))

    def create(
        self,
        *,
        email: str,
        name: str,
        hashed_password: str,
        is_admin: bool,
        mobile: str | None = None,
        role: str = "user",
    ) -> User:
        user = User(
            email=email.strip().lower(),
            mobile=mobile.strip() if mobile else None,
            name=name.strip(),
            hashed_password=hashed_password,
            is_admin=is_admin,
            role=role,
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user


class SQLAlchemyChatRepository:
    def __init__(self, db: Session) -> None:
        self.db = db

    def get_for_user(self, chat_id: str, user_id: str) -> Chat | None:
        return self.db.scalar(select(Chat).where(Chat.id == chat_id, Chat.user_id == user_id))

    def list_for_user(self, user_id: str) -> list[Chat]:
        return list(
            self.db.scalars(
                select(Chat).where(Chat.user_id == user_id).order_by(Chat.updated_at.desc())
            )
        )
