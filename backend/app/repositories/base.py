from typing import Protocol

from app.models.chat import Chat
from app.models.user import User


class UserRepository(Protocol):
    def get_by_email(self, email: str) -> User | None: ...
    def get_by_mobile(self, mobile: str) -> User | None: ...

    def create(
        self,
        *,
        email: str,
        name: str,
        hashed_password: str,
        is_admin: bool,
        mobile: str | None = None,
        role: str = "user",
    ) -> User: ...


class ChatRepository(Protocol):
    def get_for_user(self, chat_id: str, user_id: str) -> Chat | None: ...

    def list_for_user(self, user_id: str) -> list[Chat]: ...
