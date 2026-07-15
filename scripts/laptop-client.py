from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path


API_BASE_URL = os.getenv("AUTO_AI_API_BASE_URL", "http://localhost:8000/api/v1").rstrip("/")
ACCESS_TOKEN = os.getenv("AUTO_AI_ACCESS_TOKEN", "").strip()
DEVICE_ID_FILE = Path.home() / ".auto_ai_laptop_device_id"
INTERVAL_SECONDS = max(1.0, float(os.getenv("AUTO_AI_DEVICE_INTERVAL", "1")))


def device_id() -> str:
    if DEVICE_ID_FILE.exists():
        value = DEVICE_ID_FILE.read_text(encoding="utf-8").strip()
        if value:
            return value
    value = f"laptop-{uuid.uuid4()}"
    DEVICE_ID_FILE.write_text(value, encoding="utf-8")
    return value


def format_bytes(value: int) -> str:
    amount = float(max(0, value))
    for unit in ("B", "KB", "MB", "GB"):
        if amount < 1024 or unit == "GB":
            return f"{amount:.2f} {unit}" if unit == "GB" else f"{amount:.1f} {unit}"
        amount /= 1024
    return f"{amount:.2f} GB"


def memory_stats() -> tuple[str | None, str | None]:
    try:
        import psutil  # type: ignore

        memory = psutil.virtual_memory()
        return format_bytes(int(memory.total)), format_bytes(int(memory.used))
    except Exception:
        return None, None


def battery_level() -> int | None:
    try:
        import psutil  # type: ignore

        battery = psutil.sensors_battery()
        if battery is None:
            return None
        return max(0, min(100, int(round(battery.percent))))
    except Exception:
        return None


def network_type() -> str:
    try:
        socket.create_connection(("8.8.8.8", 53), timeout=1).close()
        return "WiFi/Ethernet"
    except OSError:
        return "offline"


def current_app() -> str:
    return os.getenv("AUTO_AI_CURRENT_APP", "unknown")


def location() -> dict[str, float] | None:
    lat = os.getenv("AUTO_AI_LAT")
    lng = os.getenv("AUTO_AI_LNG")
    if not lat or not lng:
        return None
    try:
        return {"lat": float(lat), "lng": float(lng)}
    except ValueError:
        return None


def collect_payload(device_id_value: str) -> dict[str, object]:
    total, used, free = shutil.disk_usage(Path.home())
    ram_total, ram_used = memory_stats()
    payload: dict[str, object] = {
        "deviceId": device_id_value,
        "type": "laptop",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "battery": battery_level(),
        "screenOn": True,
        "currentApp": current_app(),
        "network": network_type(),
        "storageTotal": format_bytes(total),
        "storageUsed": format_bytes(used),
        "storageFree": format_bytes(free),
        "ramTotal": ram_total,
        "ramUsed": ram_used,
        "deviceModel": socket.gethostname(),
        "osVersion": f"{platform.system()} {platform.release()}",
        "isActive": True,
    }
    loc = location()
    if loc:
        payload["location"] = loc
    return {key: value for key, value in payload.items() if value is not None}


def send_payload(payload: dict[str, object]) -> bool:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{API_BASE_URL}/device/activity",
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Authorization": f"Bearer {ACCESS_TOKEN}",
            "Content-Type": "application/json; charset=utf-8",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return 200 <= response.status < 300
    except urllib.error.HTTPError as error:
        if error.code == 401:
            raise SystemExit("Unauthorized. Set AUTO_AI_ACCESS_TOKEN to a valid user JWT.") from error
        print(f"Telemetry rejected: HTTP {error.code}")
    except OSError as error:
        print(f"Network error: {error}")
    return False


def main() -> None:
    if not ACCESS_TOKEN:
        raise SystemExit("Missing AUTO_AI_ACCESS_TOKEN.")
    current_device_id = device_id()
    while True:
        send_payload(collect_payload(current_device_id))
        time.sleep(INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
