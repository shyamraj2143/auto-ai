#!/usr/bin/env python3
"""Download a published APK and require byte-for-byte size/checksum equality."""
from __future__ import annotations

import argparse
import hashlib
import sys
from urllib import request


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", required=True)
    parser.add_argument("--size", required=True, type=int)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    digest = hashlib.sha256()
    size = 0
    req = request.Request(args.url, headers={"Accept": "application/vnd.android.package-archive"})
    with request.urlopen(req, timeout=180) as response:
        while chunk := response.read(1024 * 1024):
            size += len(chunk)
            digest.update(chunk)
    actual = digest.hexdigest()
    if size != args.size or actual.lower() != args.sha256.lower():
        print(f"Published APK verification failed: size={size}, sha256={actual}", file=sys.stderr)
        return 1
    print(f"Published APK verified: size={size}, sha256={actual}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
