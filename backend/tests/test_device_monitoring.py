from datetime import datetime, timedelta

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.device_monitoring import UserDeviceActivity
from app.models.user import User
from app.schemas.device_monitoring import DeviceActivityCreate, DeviceLocation
from app.services.device_monitoring import clean_old_activities, create_activity, ensure_device_snapshots, latest_activities, list_device_users


def db_session() -> Session:
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    return Session(engine)


def create_user(db: Session, user_id: str = "device-user") -> User:
    user = User(
        id=user_id,
        email=f"{user_id}@example.test",
        name="Device User",
        username=user_id,
        hashed_password="unused",
        is_active=True,
    )
    db.add(user)
    db.commit()
    return user


def test_device_activity_is_persisted_and_serialized() -> None:
    with db_session() as db:
        user = create_user(db)
        activity = create_activity(
            db,
            user,
            DeviceActivityCreate(
                battery=87,
                screenOn=True,
                currentApp="com.autoai.app",
                location=DeviceLocation(lat=28.6139, lng=77.2090),
                network="wifi",
                storageFree="12.5 GB",
                ramUsage="2.0 GB / 8.0 GB",
                deviceModel="Pixel",
                osVersion="14",
            ),
        )

        assert activity.userId == user.id
        assert activity.battery == 87
        assert activity.location
        assert activity.location.lat == 28.6139
        assert len(latest_activities(db, user.id)) == 1


def test_clean_old_activities_keeps_last_24_hours() -> None:
    with db_session() as db:
        user = create_user(db)
        db.add_all(
            [
                UserDeviceActivity(user_id=user.id, timestamp=datetime.utcnow() - timedelta(hours=25), battery=10),
                UserDeviceActivity(user_id=user.id, timestamp=datetime.utcnow() - timedelta(hours=1), battery=90),
            ]
        )
        db.commit()

        assert clean_old_activities(db, user.id) == 1
        rows = db.scalars(select(UserDeviceActivity).where(UserDeviceActivity.user_id == user.id)).all()
        assert len(rows) == 1
        assert rows[0].battery == 90


def test_device_user_summary_marks_recent_activity_online() -> None:
    with db_session() as db:
        user = create_user(db)
        db.add(UserDeviceActivity(user_id=user.id, timestamp=datetime.utcnow(), device_model="Pixel", os_version="14"))
        db.commit()

        rows = list_device_users(db)
        assert rows[0].userId == user.id
        assert rows[0].online is True
        assert rows[0].deviceModel == "Pixel"


def test_empty_user_devices_do_not_generate_demo_devices() -> None:
    with db_session() as db:
        user = create_user(db, "empty-device-user")

        snapshots = ensure_device_snapshots(db, user.id)

        assert snapshots == {"mobile": [], "laptop": []}
        assert db.scalars(select(UserDeviceActivity).where(UserDeviceActivity.user_id == user.id)).all() == []


def test_device_snapshots_are_scoped_to_selected_user() -> None:
    with db_session() as db:
        user_a = create_user(db, "device-user-a")
        user_b = create_user(db, "device-user-b")
        db.add(
            UserDeviceActivity(
                user_id=user_b.id,
                device_id="real-android-b",
                device_type="mobile",
                timestamp=datetime.utcnow(),
                device_model="Real Android Device",
                os_version="Android 15",
                is_active=True,
            )
        )
        db.commit()

        user_a_snapshots = ensure_device_snapshots(db, user_a.id)
        user_b_snapshots = ensure_device_snapshots(db, user_b.id)

        assert user_a_snapshots == {"mobile": [], "laptop": []}
        assert [device.deviceId for device in user_b_snapshots["mobile"]] == ["real-android-b"]
