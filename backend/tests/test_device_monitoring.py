import json

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from app.api.deps import get_current_user
from app.api.routes import admin, device_monitoring
from app.db.base import Base
from app.db.session import get_db
from app.models.call import DeviceCommand, UserDevice
from app.models.device_monitoring import UserDeviceActivity
from app.models.user import User
from app.schemas.device_monitoring import DeviceRegisterRequest
from app.services.device_token_security import decrypt_token, token_hash
from app.services.device_monitoring import upsert_registered_device


def db_session() -> Session:
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return sessionmaker(bind=engine)()


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
    db.refresh(user)
    return user


def client_for(db: Session, user: User, include_admin: bool = False) -> TestClient:
    app = FastAPI()
    app.include_router(device_monitoring.router, prefix="/api/v1")
    if include_admin:
        app.include_router(admin.router, prefix="/api/v1")

    def override_db():
        yield db

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def activity_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(UserDeviceActivity)) or 0


def command_count(db: Session) -> int:
    return db.scalar(select(func.count()).select_from(DeviceCommand)) or 0


def test_device_register_keeps_fcm_device_without_activation_gate_or_telemetry() -> None:
    with db_session() as db:
        user = create_user(db)
        client = client_for(db, user)

        response = client.post(
            "/api/v1/devices/register",
            json={
                "deviceId": "android-1",
                "userId": user.id,
                "platform": "android",
                "deviceName": "Shyam Android",
                "fcmToken": "a" * 32,
                "permissionsStatus": {"notification": True, "usageAccess": True, "accessibility": True},
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert body["registered"] is True
        assert body["activation_required"] is False
        assert body["approved"] is True
        device = db.scalar(select(UserDevice).where(UserDevice.user_id == user.id, UserDevice.device_id == "android-1"))
        assert device is not None
        assert device.is_active is True
        assert device.fcm_token_ciphertext
        assert json.loads(device.permissions_status) == {"notification": True}
        assert activity_count(db) == 0


def test_heartbeat_and_activity_are_deprecated_noops() -> None:
    with db_session() as db:
        user = create_user(db, "noop-user")
        client = client_for(db, user)

        heartbeat = client.post(
            "/api/v1/devices/heartbeat",
            json={
                "deviceId": "android-noop",
                "userId": user.id,
                "battery": 44,
                "network": "5G",
                "storageTotal": "128 GB",
                "ramUsed": "4 GB",
            },
        )
        activity = client.post(
            "/api/v1/devices/activity",
            json={
                "deviceId": "android-noop",
                "battery": 55,
                "currentApp": "com.example.hidden",
                "location": {"lat": 28.6139, "lng": 77.2090},
                "permissionGranted": True,
            },
        )

        assert heartbeat.status_code == 200
        assert heartbeat.json()["activation_required"] is False
        assert heartbeat.json()["approved"] is True
        assert activity.status_code == 200
        assert activity.json()["activation_required"] is False
        assert activity.json()["approved"] is True
        assert db.scalar(select(UserDevice).where(UserDevice.device_id == "android-noop")) is None
        assert activity_count(db) == 0


def test_old_activation_endpoints_always_allow_active_users() -> None:
    with db_session() as db:
        user = create_user(db, "activation-user")
        client = client_for(db, user)

        status_response = client.get("/api/v1/devices/activation-status/android-1")
        request_response = client.post(
            "/api/v1/devices/activation-request",
            json={"deviceId": "android-1", "userId": user.id, "platform": "android"},
        )

        assert status_response.status_code == 200
        assert status_response.json()["activation_required"] is False
        assert status_response.json()["approved"] is True
        assert status_response.json()["is_device_active"] is True
        assert request_response.status_code == 200
        assert request_response.json()["activation_required"] is False
        assert request_response.json()["approved"] is True
        assert activity_count(db) == 0


def test_deprecated_command_ack_is_noop() -> None:
    with db_session() as db:
        user = create_user(db, "ack-user")
        client = client_for(db, user)

        response = client.post(
            "/api/v1/devices/commands/not-real/ack",
            json={"deviceId": "android-1", "status": "acknowledged"},
        )

        assert response.status_code == 200
        assert response.json() == {"success": True, "deprecated": True, "status": "disabled"}
        assert command_count(db) == 0


def test_user_id_mismatch_is_rejected_for_private_device_calls() -> None:
    with db_session() as db:
        user = create_user(db, "private-user")
        client = client_for(db, user)

        response = client.post(
            "/api/v1/devices/register",
            json={"deviceId": "android-1", "userId": "other-user", "platform": "android"},
        )

        assert response.status_code == 403
        assert db.scalar(select(UserDevice).where(UserDevice.device_id == "android-1")) is None


def test_admin_device_monitoring_routes_are_removed() -> None:
    with db_session() as db:
        user = create_user(db, "admin-user")
        user.role = "admin"
        user.is_admin = True
        db.commit()
        client = client_for(db, user, include_admin=True)

        assert client.get("/api/v1/admin/device-users").status_code == 404
        assert client.get(f"/api/v1/admin/users/{user.id}/devices").status_code == 404
        assert client.post(f"/api/v1/admin/remote-start/{user.id}").status_code == 404
        assert client.post(f"/api/v1/admin/ai-clean/{user.id}").status_code == 404


def test_register_service_upserts_without_telemetry_fields() -> None:
    with db_session() as db:
        user = create_user(db, "service-user")
        payload = DeviceRegisterRequest(
            deviceId="android-service",
            userId=user.id,
            platform="android",
            deviceName="First",
            fcmToken="b" * 32,
            permissionsStatus={"notification": False, "usageAccess": True},
        )

        first = upsert_registered_device(db, user, payload)
        second = upsert_registered_device(db, user, payload.model_copy(update={"deviceName": "Second"}))

        devices = db.scalars(select(UserDevice).where(UserDevice.user_id == user.id)).all()
        assert len(devices) == 1
        assert first.id == second.id
        assert second.device_name == "Second"
        assert second.battery_level is None
        assert second.storage_total is None
        assert second.ram_total is None
        assert json.loads(second.permissions_status) == {"notification": False}
        assert activity_count(db) == 0


def test_firebase_installation_id_never_overwrites_the_real_fcm_token() -> None:
    with db_session() as db:
        user = create_user(db, "push-identity-user")
        valid_token = "valid-fcm-registration-token-" + "x" * 32
        installation_id = "firebase-installation-id-123"

        first = upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-push",
                platform="android",
                fcmToken=valid_token,
                firebaseInstallationId=installation_id,
            ),
        )
        overwritten = upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-push",
                platform="android",
                fcmToken=installation_id,
                firebaseInstallationId=installation_id,
            ),
        )

        assert first.id == overwritten.id
        assert decrypt_token(overwritten.fcm_token_ciphertext) == valid_token
        assert overwritten.fcm_token_hash == token_hash(valid_token)
        assert overwritten.firebase_installation_id_hash == token_hash(installation_id)
        assert overwritten.last_fcm_failure_code == "FCM_TOKEN_EQUALS_INSTALLATION_ID"


def test_installation_only_registration_waits_for_a_real_fcm_token() -> None:
    with db_session() as db:
        user = create_user(db, "installation-only-user")
        installation_id = "firebase-installation-only-456"

        device = upsert_registered_device(
            db,
            user,
            DeviceRegisterRequest(
                deviceId="android-installation-only",
                platform="android",
                fcmToken=installation_id,
                firebaseInstallationId=installation_id,
            ),
        )

        assert device.is_active is True
        assert device.fcm_token_ciphertext is None
        assert device.fcm_token_hash is None
        assert device.firebase_installation_id_hash == token_hash(installation_id)
        assert device.last_fcm_failure_code == "FCM_TOKEN_EQUALS_INSTALLATION_ID"
