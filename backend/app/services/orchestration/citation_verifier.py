from __future__ import annotations

import re
import ipaddress
from urllib.parse import urlsplit


class CitationVerifier:
    @staticmethod
    def safe_public_url(url: str) -> bool:
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower().rstrip(".")
        if parsed.scheme not in {"http", "https"} or not host or host == "localhost" or host.endswith(".localhost"):
            return False
        try:
            address = ipaddress.ip_address(host)
            return not (
                address.is_private
                or address.is_loopback
                or address.is_link_local
                or address.is_reserved
                or address.is_multicast
            )
        except ValueError:
            return True

    @staticmethod
    def verify(content: str, evidence: list[dict]) -> tuple[str, int]:
        accepted = {
            str(item.get("url", "")).rstrip("/")
            for item in evidence
            if isinstance(item, dict)
            and CitationVerifier.safe_public_url(str(item.get("url", "")))
            and item.get("title")
        }
        cited = set(re.findall(r"https?://[^\s)\]>]+", content))
        invalid = {url for url in cited if url.rstrip("/") not in accepted or urlsplit(url).hostname is None}
        for url in invalid:
            content = content.replace(url, "")
        return content, len({url.rstrip("/") for url in cited if url.rstrip("/") in accepted})


citation_verifier = CitationVerifier()
