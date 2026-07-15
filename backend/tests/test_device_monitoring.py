from datetime import datetime, timedelta

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models.call import DeviceCommand, UserDevice
from app.models.device_monitoring import UserDeviceActivity
from app.models.user import User
from app.schemas.device_monitoring import DeviceActivityCreate, DeviceHeartbeatRequest, DeviceLocation, DeviceRegisterRequest
from app.services.device_monitoring import acknowledge_device_command, clean_old_activities, create_activity, ensure_device_snapshots, heartbeat_device_activity, latest_activities, latest_device_activities, list_device_users, send_device_command, upsert_registered_device
from app.services.firebase_notifications import FcmSendResult


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


def test_registered_android_device_appears_without_telemetry() -> None:
    with db_session() as db:
        user = create_user(db, "registered-device-user")
        db.add(
            UserDevice(
                user_id=user.id,
                device_id="android-real-1",
                platform="android",
                device_name="Shyam Android",
                is_active=True,
                last_seen_at=datetime.utcnow(),
            )
        )
        db.commit()

        snapshots = ensure_device_snapshots(db, user.id)

        assert len(snapshots["mobile"]) == 1
        assert snapshots["mobile"][0].deviceId == "android-real-1"
        assert snapshots["mobile"][0].deviceName == "Shyam Android"
        assert snapshots["mobile"][0].status == "online"
        assert snapshots["laptop"] == []


def test_device_register_upserts_by_user_and_device_id() -> None:
    with db_session() as db:
        user = create_user(db, "registered-upsert-user")

        upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-upsert-1",
                userId=user.id,
                platform="android",
                deviceName="First Name",
                osVersion="Android 14",
                appVersion="1.0.0",
            ),
        )
        upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-upsert-1",
                userId=user.id,
                platform="android",
                deviceName="Updated Name",
                osVersion="Android 15",
                appVersion="1.0.1",
            ),
        )

        devices = db.scalars(select(UserDevice).where(UserDevice.user_id == user.id)).all()
        assert len(devices) == 1
        assert devices[0].device_name == "Updated Name"
        assert devices[0].os_version == "Android 15"


def test_device_heartbeat_updates_card_telemetry() -> None:
    with db_session() as db:
        user = create_user(db, "heartbeat-user")
        upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-heartbeat-1",
                userId=user.id,
                platform="android",
                deviceName="Heartbeat Android",
                osVersion="Android 15",
                appVersion="1.0.0",
            ),
        )

        activity = heartbeat_device_activity(
            db,
            user,
            DeviceHeartbeatRequest(
                deviceId="android-heartbeat-1",
                userId=user.id,
                battery=74,
                network="5G",
                screenStatus="on",
                lastSeenAt=datetime.utcnow(),
            ),
        )
        snapshots = ensure_device_snapshots(db, user.id)

        assert activity.deviceId == "android-heartbeat-1"
        assert snapshots["mobile"][0].deviceName == "Heartbeat Android"
        assert snapshots["mobile"][0].battery == 74
        assert snapshots["mobile"][0].network == "5G"
        assert snapshots["mobile"][0].screenOn is True


def test_activity_without_permission_does_not_store_foreground_app() -> None:
    with db_session() as db:
        user = create_user(db, "activity-consent-denied")

        activity = create_activity(
            db,
            user,
            DeviceActivityCreate(
                deviceId="android-consent-1",
                currentApp="com.example.hidden",
                foregroundAppName="Hidden App",
                foregroundPackageName="com.example.hidden",
                source="usage_stats",
                permissionGranted=False,
            ),
        )
        details = latest_device_activities(db, user.id, "android-consent-1")

        assert activity.permissionGranted is False
        assert activity.currentApp is None
        assert details.permissionGranted is False
        assert details.currentForegroundApp is None


def test_activity_with_permission_exposes_real_foreground_app() -> None:
    with db_session() as db:
        user = create_user(db, "activity-consent-granted")

        activity = create_activity(
            db,
            user,
            DeviceActivityCreate(
                deviceId="android-consent-2",
                currentApp="com.whatsapp",
                foregroundAppName="WhatsApp",
                foregroundPackageName="com.whatsapp",
                source="usage_stats",
                permissionGranted=True,
            ),
        )
        details = latest_device_activities(db, user.id, "android-consent-2")

        assert activity.permissionGranted is True
        assert activity.currentApp == "com.whatsapp"
        assert details.permissionGranted is True
        assert details.currentForegroundApp == "WhatsApp"
        assert details.usageSummary[0]["app"] == "WhatsApp"


def test_remote_start_command_is_sent_and_acknowledged(monkeypatch) -> None:
    with db_session() as db:
        user = create_user(db, "command-user")
        upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-command-1",
                userId=user.id,
                platform="android",
                deviceName="Command Android",
                fcmToken="a" * 32,
            ),
        )

        sent_payloads = []

        def fake_send_device_command(token: str, **payload):
            sent_payloads.append((token, payload))
            return FcmSendResult(ok=True)

        monkeypatch.setattr("app.services.device_monitoring.firebase_notification_service.send_device_command", fake_send_device_command)
        sent, failed, command = send_device_command(db, user.id, "remote-start", "Start", "Start monitoring", "android-command-1")

        assert sent == 1
        assert failed == 0
        assert command is not None
        assert command.status == "sent"
        assert sent_payloads[0][1]["command_id"] == command.id

        acknowledged = acknowledge_device_command(db, user, command.id, "android-command-1")

        assert acknowledged is not None
        assert acknowledged.status == "acknowledged"
        assert acknowledged.acknowledged_at is not None
        stored = db.get(DeviceCommand, command.id)
        assert stored is not None
        assert stored.status == "acknowledged"


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
