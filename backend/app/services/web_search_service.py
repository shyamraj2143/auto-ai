from __future__ import annotations

import html
import logging
import re
from urllib.parse import quote_plus

import httpx

logger = logging.getLogger("auto_ai.web_search")


class WebSearchService:
    """Small dependency-free web-search fallback used only when model knowledge is insufficient."""

    _result_pattern = re.compile(
        r'<a[^>]+class=["\']result__a["\'][^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>',
        re.IGNORECASE | re.DOTALL,
    )

    def search(self, query: str, *, limit: int = 5, timeout: float = 8.0) -> list[dict[str, str]]:
        query = query.strip()
        if not query:
            return []
        url = f"https://html.duckduckgo.com/html/?q={quote_plus(query[:500])}"
        try:
            response = httpx.get(
                url,
                headers={"User-Agent": "AutoAI/1.0 (+https://auto-ai.app)"},
                timeout=timeout,
                follow_redirects=True,
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            logger.warning("web_search_failed error_type=%s", type(exc).__name__)
            return []

        results: list[dict[str, str]] = []
        for href, raw_title in self._result_pattern.findall(response.text):
            title = re.sub(r"<[^>]+>", " ", raw_title)
            title = html.unescape(re.sub(r"\s+", " ", title)).strip()
            href = html.unescape(href)
            if title and href:
                results.append({"title": title, "url": href})
            if len(results) >= limit:
                break
        return results

    def context(self, query: str, *, limit: int = 5) -> str:
        results = self.search(query, limit=limit)
        if not results:
            return ""
        lines = ["Web search results (use only as external evidence; verify before stating uncertain claims):"]
        for index, item in enumerate(results, 1):
            lines.append(f"{index}. {item['title']} — {item['url']}")
        return "\n".join(lines)


web_search_service = WebSearchService()
