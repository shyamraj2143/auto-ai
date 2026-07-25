import hashlib
import re
from datetime import datetime, timedelta
from urllib.parse import urlparse

import httpx
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.search import SearchCache, SearchRun
from app.schemas.search import SearchResultBundle, SearchSource


FRESHNESS_TERMS = {
    "breaking",
    "current",
    "latest",
    "live",
    "news",
    "now",
    "price",
    "recent",
    "release",
    "released",
    "schedule",
    "score",
    "stock",
    "today",
    "tomorrow",
    "tonight",
    "update",
    "updated",
    "weather",
    "yesterday",
}

FRESHNESS_PHRASES = ("अभी", "आज", "ताज़ा", "ताजा", "मौसम", "खबर", "समाचार")

AUTHORITY_DOMAINS = {
    "apnews.com",
    "bbc.com",
    "docs.python.org",
    "ecfr.gov",
    "europa.eu",
    "fda.gov",
    "ft.com",
    "github.com",
    "gov.uk",
    "imf.org",
    "irs.gov",
    "microsoft.com",
    "nature.com",
    "nih.gov",
    "nvidia.com",
    "openai.com",
    "python.org",
    "reuters.com",
    "sec.gov",
    "statista.com",
    "theverge.com",
    "who.int",
    "worldbank.org",
}


class SearchAgent:
    @staticmethod
    def effective_mode(mode: str | None, web_search: bool = False) -> str:
        selected = (mode or "off").lower()
        if selected not in {"off", "auto", "web", "news", "research", "deep"}:
            selected = "auto"
        if web_search and selected in {"off", "auto"}:
            return "web"
        return selected

    @staticmethod
    def should_search(query: str, mode: str) -> tuple[bool, str]:
        if mode == "off":
            return False, "Web search disabled."
        if mode in {"web", "news", "research", "deep"}:
            return True, f"{mode.title()} mode requires web sources."

        text = query.lower()
        words = set(re.findall(r"[a-z0-9]+", text))
        current_year = datetime.utcnow().year
        if words & FRESHNESS_TERMS or any(term in text for term in FRESHNESS_PHRASES):
            return True, "Freshness-sensitive wording detected."
        if re.search(r"\b(20[2-9]\d|19\d\d)\b", text):
            years = {int(value) for value in re.findall(r"\b(20[2-9]\d|19\d\d)\b", text)}
            if any(year >= current_year - 1 for year in years):
                return True, "Recent year detected."
        if re.search(r"\b(ceo|president|prime minister|winner|won|version|changelog|rate|law|regulation)\b", text):
            return True, "Entity or rule likely changes over time."
        if re.search(r"https?://|www\.", text):
            return True, "URL lookup requires web retrieval."
        return False, "Answer appears stable enough for model knowledge."


class SourceValidationAgent:
    @staticmethod
    def domain(url: str) -> str:
        parsed = urlparse(url)
        host = parsed.netloc.lower().removeprefix("www.")
        return host.split(":", 1)[0]

    @classmethod
    def score(cls, *, url: str, snippet: str, published_at: str | None, position: int) -> tuple[float, str]:
        parsed = urlparse(url)
        domain = cls.domain(url)
        score = 0.35
        if parsed.scheme == "https":
            score += 0.12
        if domain.endswith(".gov") or domain.endswith(".edu"):
            score += 0.24
        if domain in AUTHORITY_DOMAINS or any(domain.endswith(f".{item}") for item in AUTHORITY_DOMAINS):
            score += 0.18
        if len(snippet.strip()) >= 90:
            score += 0.08
        if published_at:
            score += 0.06
        if position <= 3:
            score += 0.05
        elif position <= 6:
            score += 0.02

        score = max(0.0, min(score, 0.99))
        label = "high" if score >= 0.75 else "medium" if score >= 0.52 else "low"
        return round(score, 2), label

    @classmethod
    def validate_and_rank(cls, raw_sources: list[dict], provider: str) -> list[SearchSource]:
        seen: set[str] = set()
        ranked: list[tuple[int, SearchSource]] = []
        for index, item in enumerate(raw_sources, start=1):
            url = str(item.get("url") or item.get("link") or "").strip()
            title = str(item.get("title") or "Untitled source").strip()
            snippet = str(item.get("snippet") or item.get("content") or item.get("description") or "").strip()
            if not url or not title or not urlparse(url).scheme:
                continue
            normalized_url = url.split("#", 1)[0].rstrip("/")
            if normalized_url in seen:
                continue
            seen.add(normalized_url)
            published_at = item.get("published_at") or item.get("published_date") or item.get("date")
            credibility_score, credibility_label = cls.score(
                url=url,
                snippet=snippet,
                published_at=str(published_at) if published_at else None,
                position=int(item.get("position") or index),
            )
            ranked.append(
                (
                    index,
                    SearchSource(
                        id="",
                        title=title[:240],
                        url=url,
                        snippet=snippet[:900],
                        source=cls.domain(url),
                        provider=provider,
                        published_at=str(published_at) if published_at else None,
                        credibility_score=credibility_score,
                        credibility_label=credibility_label,
                    ),
                )
            )

        ranked.sort(key=lambda item: (item[1].credibility_score, -item[0]), reverse=True)
        sources: list[SearchSource] = []
        for index, (_, source) in enumerate(ranked, start=1):
            source.id = f"S{index}"
            sources.append(source)
        return sources


class SummarizationAgent:
    @staticmethod
    def summarize(query: str, sources: list[SearchSource], provider_answer: str | None = None) -> str:
        if provider_answer:
            return provider_answer.strip()[:1800]
        if not sources:
            return ""
        fragments = []
        for source in sources[:5]:
            text = source.snippet or source.title
            fragments.append(f"[{source.id}] {text}")
        return f"Search findings for '{query}': " + " ".join(fragments)[:1800]

    @staticmethod
    def confidence(sources: list[SearchSource]) -> float:
        if not sources:
            return 0
        top = sources[: min(len(sources), 5)]
        score = sum(source.credibility_score for source in top) / len(top)
        coverage_bonus = min(len(sources), 6) * 0.025
        return round(min(score + coverage_bonus, 0.98), 2)


class WebSearchService:
    def __init__(self) -> None:
        self.search_agent = SearchAgent()
        self.validator = SourceValidationAgent()
        self.summarizer = SummarizationAgent()

    @staticmethod
    def _query_hash(query: str) -> str:
        normalized = " ".join(query.lower().split())
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()

    @staticmethod
    def _max_results(mode: str) -> int:
        return settings.SEARCH_DEEP_MAX_RESULTS if mode == "deep" else settings.SEARCH_MAX_RESULTS

    @staticmethod
    def _as_bundle(data: dict) -> SearchResultBundle:
        return SearchResultBundle.model_validate(data)

    def _get_cache(self, db: Session, query: str, mode: str) -> SearchResultBundle | None:
        cache = db.scalar(
            select(SearchCache).where(
                SearchCache.query_hash == self._query_hash(query),
                SearchCache.mode == mode,
                SearchCache.expires_at > datetime.utcnow(),
            )
        )
        if not cache:
            return None
        bundle = self._as_bundle(cache.result_data)
        bundle.cache_hit = True
        bundle.provider = cache.provider
        return bundle

    def _store_cache(self, db: Session, query: str, mode: str, bundle: SearchResultBundle) -> None:
        data = bundle.model_dump(mode="json")
        cache = db.scalar(
            select(SearchCache).where(
                SearchCache.query_hash == self._query_hash(query),
                SearchCache.mode == mode,
            )
        )
        expires_at = datetime.utcnow() + timedelta(seconds=settings.SEARCH_CACHE_TTL_SECONDS)
        if cache:
            cache.provider = bundle.provider
            cache.result_data = data
            cache.expires_at = expires_at
            cache.updated_at = datetime.utcnow()
        else:
            db.add(
                SearchCache(
                    query_hash=self._query_hash(query),
                    query=query,
                    mode=mode,
                    provider=bundle.provider,
                    result_data=data,
                    expires_at=expires_at,
                )
            )

    @staticmethod
    def _raise_provider_error(provider: str, status_code: int, body: str) -> None:
        detail = body[:500]
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"{provider} search failed ({status_code}): {detail}",
        )

    def _search_tavily(self, query: str, mode: str) -> tuple[str, list[dict], str | None]:
        if not settings.TAVILY_API_KEY:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="TAVILY_API_KEY is not configured.")

        payload = {
            "query": query[:400],
            "topic": "news" if mode == "news" else "general",
            "search_depth": "advanced" if mode in {"research", "deep"} else "basic",
            "include_answer": True,
            "include_raw_content": False,
            "max_results": self._max_results(mode),
        }
        if mode == "auto":
            payload["auto_parameters"] = True

        try:
            response = httpx.post(
                "https://api.tavily.com/search",
                headers={
                    "Authorization": f"Bearer {settings.TAVILY_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=25,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Tavily search failed: {exc}") from exc

        if response.status_code >= 400:
            self._raise_provider_error("Tavily", response.status_code, response.text)

        data = response.json()
        raw_results = []
        for index, item in enumerate(data.get("results") or [], start=1):
            raw_results.append(
                {
                    "title": item.get("title"),
                    "url": item.get("url"),
                    "snippet": item.get("content"),
                    "published_at": item.get("published_date"),
                    "position": index,
                }
            )
        return "tavily", raw_results, data.get("answer")

    def _search_serper(self, query: str, mode: str) -> tuple[str, list[dict], str | None]:
        if not settings.SERPER_API_KEY:
            raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="SERPER_API_KEY is not configured.")

        endpoint = "news" if mode == "news" else "search"
        try:
            response = httpx.post(
                f"https://google.serper.dev/{endpoint}",
                headers={
                    "X-API-KEY": settings.SERPER_API_KEY,
                    "Content-Type": "application/json",
                },
                json={
                    "q": query[:400],
                    "num": self._max_results(mode),
                    "gl": settings.SEARCH_COUNTRY,
                    "hl": settings.SEARCH_LANGUAGE,
                },
                timeout=25,
            )
        except httpx.HTTPError as exc:
            raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Serper search failed: {exc}") from exc

        if response.status_code >= 400:
            self._raise_provider_error("Serper", response.status_code, response.text)

        data = response.json()
        result_key = "news" if mode == "news" else "organic"
        raw_results = []
        for index, item in enumerate(data.get(result_key) or [], start=1):
            raw_results.append(
                {
                    "title": item.get("title"),
                    "url": item.get("link"),
                    "snippet": item.get("snippet"),
                    "published_at": item.get("date"),
                    "source": item.get("source"),
                    "position": item.get("position") or index,
                }
            )
        return "serper", raw_results, None

    def _search_providers(self, query: str, mode: str) -> tuple[str, list[dict], str | None]:
        last_error: HTTPException | None = None
        if settings.TAVILY_API_KEY:
            try:
                return self._search_tavily(query, mode)
            except HTTPException as exc:
                last_error = exc
        if settings.SERPER_API_KEY:
            try:
                return self._search_serper(query, mode)
            except HTTPException as exc:
                last_error = exc
        if last_error:
            raise last_error
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Web search is not configured. Set TAVILY_API_KEY or SERPER_API_KEY.",
        )

    def execute(
        self,
        db: Session,
        *,
        user_id: str,
        query: str,
        mode: str,
        chat_id: str | None = None,
        message_id: str | None = None,
        record_history: bool = True,
    ) -> SearchResultBundle:
        should_search, reason = self.search_agent.should_search(query, mode)
        if not should_search:
            return SearchResultBundle(
                query=query,
                mode=mode,
                provider="none",
                status="skipped",
                searched=False,
                reason=reason,
            )

        dynamic_query = bool(set(re.findall(r"[a-z0-9]+", query.lower())) & FRESHNESS_TERMS) or any(
            term in query for term in FRESHNESS_PHRASES
        )
        cached = None if dynamic_query else self._get_cache(db, query, mode)
        if cached:
            cached.reason = reason
            if record_history:
                self._record_run(db, user_id, cached, chat_id=chat_id, message_id=message_id)
            return cached

        provider, raw_sources, provider_answer = self._search_providers(query, mode)
        sources = self.validator.validate_and_rank(raw_sources, provider)
        summary = self.summarizer.summarize(query, sources, provider_answer)
        bundle = SearchResultBundle(
            query=query,
            mode=mode,
            provider=provider,
            status="completed" if sources else "empty",
            cache_hit=False,
            searched=True,
            reason=reason,
            confidence_score=self.summarizer.confidence(sources),
            summary=summary,
            sources=sources,
            created_at=datetime.utcnow(),
        )
        if not dynamic_query:
            self._store_cache(db, query, mode, bundle)
        if record_history:
            self._record_run(db, user_id, bundle, chat_id=chat_id, message_id=message_id)
        return bundle

    def _record_run(
        self,
        db: Session,
        user_id: str,
        bundle: SearchResultBundle,
        *,
        chat_id: str | None,
        message_id: str | None,
    ) -> None:
        run = SearchRun(
            user_id=user_id,
            chat_id=chat_id,
            message_id=message_id,
            query=bundle.query,
            mode=bundle.mode,
            provider=bundle.provider,
            status=bundle.status,
            cache_hit=bundle.cache_hit,
            confidence_score=bundle.confidence_score,
            summary=bundle.summary,
            results=bundle.model_dump(mode="json"),
        )
        db.add(run)
        db.flush()
        bundle.run_id = run.id
        run.results = bundle.model_dump(mode="json")

    @staticmethod
    def build_model_context(bundle: SearchResultBundle | None) -> str:
        if not bundle or not bundle.searched or not bundle.sources:
            return ""
        lines = [
            "Use this verified web search context when answering. Cite claims from these sources with bracket citations like [S1].",
            f"Query: {bundle.query}",
            f"Mode: {bundle.mode}; Provider: {bundle.provider}; Confidence: {round(bundle.confidence_score * 100)}%",
            f"Search summary: {bundle.summary}",
            "Sources:",
        ]
        for source in bundle.sources:
            published = f"; published: {source.published_at}" if source.published_at else ""
            lines.append(
                f"[{source.id}] {source.title} ({source.source}; credibility: {source.credibility_label}{published})\n"
                f"URL: {source.url}\n"
                f"Snippet: {source.snippet}"
            )
        return "\n\n".join(lines)

    @staticmethod
    def ensure_citations(content: str, bundle: SearchResultBundle | None) -> str:
        if not bundle or not bundle.sources or re.search(r"\[S\d+\]", content):
            return content
        citations = " ".join(f"[{source.id}]({source.url})" for source in bundle.sources[:4])
        return f"{content.rstrip()}\n\nSources: {citations}"


web_search_service = WebSearchService()
