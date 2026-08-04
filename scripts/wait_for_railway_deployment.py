#!/usr/bin/env python3
"""Wait until the public Railway health endpoint serves the expected commit."""
from __future__ import annotations

import argparse
import json
import sys
import time
from urllib import error, request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--health-url", required=True)
    parser.add_argument("--commit-sha", required=True)
    parser.add_argument("--timeout", type=int, default=900)
    parser.add_argument("--interval", type=int, default=10)
    args = parser.parse_args()
    deadline = time.monotonic() + args.timeout
    expected = args.commit_sha.lower()
    last = "no response"
    while time.monotonic() < deadline:
        try:
            req = request.Request(args.health_url, headers={"Accept": "application/json", "Cache-Control": "no-cache"})
            with request.urlopen(req, timeout=15) as response:
                payload = json.loads(response.read().decode("utf-8"))
            actual = str(payload.get("commit_sha") or "").lower()
            if payload.get("status") == "ok" and actual == expected:
                print(json.dumps({"deployment_id": payload.get("deployment_id"), "commit_sha": actual}))
                return 0
            last = f"status={payload.get('status')!r}, commit_sha={actual!r}"
        except (error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            last = str(exc)
        time.sleep(max(1, args.interval))
    print(f"Railway deployment did not become healthy for {expected}: {last}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
