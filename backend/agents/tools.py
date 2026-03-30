"""All tool functions for LeadCall AI agents, with Orq AI tracing + DB persistence.

Integrations:
- Firecrawl (multi-page crawl) with BS4 fallback
- Brave Search API (web search with location/language)
- Google Maps Places API (local business discovery)
- ElevenLabs Conversational AI (agent creation with dynamic variables)
- Twilio (outbound calls via webhook)
- Orq AI (@traced on every tool)
- PostgreSQL/SQLite persistence

Security:
- SSRF prevention on all URL crawling (security.is_safe_url)
- E.164 phone validation before calls (security.validate_phone_number)
- No internal errors exposed to clients
- PII redacted in logs
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from urllib.parse import urljoin, urlparse

import time

import httpx
import requests
from bs4 import BeautifulSoup
from orq_ai_sdk.traced import traced, current_span

from security import is_safe_url, validate_phone_number, sanitize_phone_for_log

logger = logging.getLogger(__name__)


def _retry_request(method: str, url: str, max_retries: int = 3, **kwargs) -> requests.Response:
    """HTTP request with exponential backoff retry on 429, 5xx, and transient errors."""
    for attempt in range(max_retries + 1):
        try:
            resp = requests.request(method, url, **kwargs)
            if resp.status_code == 429 or resp.status_code >= 500:
                if attempt < max_retries:
                    wait = 2 ** (attempt + 1)  # 2, 4, 8s
                    logger.warning("[Retry] %d from %s, waiting %ds (attempt %d/%d)",
                                   resp.status_code, url.split("?")[0], wait, attempt + 1, max_retries)
                    time.sleep(wait)
                    continue
            return resp
        except (requests.ConnectionError, requests.Timeout) as e:
            if attempt < max_retries:
                wait = 2 ** (attempt + 1)
                logger.warning("[Retry] Connection error for %s: %s, waiting %ds", url.split("?")[0], e, wait)
                time.sleep(wait)
                continue
            raise
    return resp  # return last response even if failed

from db import (
    create_campaign,
    update_campaign_analysis,
    get_latest_campaign,
    save_leads_db,
    update_lead_scores,
    save_pitches_db,
    update_judged_pitches_db,
    save_agent_db,
    save_call_db,
    save_prefs_db,
    get_prefs_db,
    get_campaign_state,
    _empty_state,
)


# ─── Campaign-scoped state (DB-backed with in-memory cache) ────────────────
#
# pipeline_state is a dict that acts as a cache. On first access per campaign,
# it loads from DB. All writes go to both the cache AND DB.
# The active campaign_id is set by the server before running the pipeline.

pipeline_state: dict = _empty_state()


def load_campaign_state(campaign_id: int) -> None:
    """Load a campaign's state from DB into the pipeline_state cache.
    Updates in-place to preserve references from server.py.
    """
    if campaign_id and campaign_id > 0:
        new_state = get_campaign_state(campaign_id)
    else:
        new_state = _empty_state()
    pipeline_state.clear()
    pipeline_state.update(new_state)


def reset_pipeline_state() -> None:
    """Reset the pipeline state cache to empty.
    Updates in-place to preserve references from server.py.
    """
    pipeline_state.clear()
    pipeline_state.update(_empty_state())


def _campaign_id() -> int:
    """Get or create current campaign ID."""
    cid = pipeline_state.get("campaign_id")
    if cid:
        return cid
    camp = get_latest_campaign(pipeline_state.get("user_id", ""))
    if camp:
        pipeline_state["campaign_id"] = camp["id"]
        return camp["id"]
    return 0


# ═══════════════════════════════════════════════════════════════════════════════
# 1. WEBSITE ANALYZER TOOLS — Multi-page crawling
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="crawl_website")
def crawl_website(url: str, max_pages: int = 3) -> dict:
    """Crawls a website across multiple pages to extract comprehensive business info.

    Uses Firecrawl API if available (handles JS, anti-bot, returns clean markdown).
    Falls back to requests+BeautifulSoup with internal link following.

    Args:
        url: The business website URL (e.g. https://icetrust.ro)
        max_pages: Maximum number of pages to crawl (default 3, max 5 to save credits)

    Returns:
        dict with status, pages crawled (url, title, content), and total_content
    """
    if not url.startswith("http"):
        url = "https://" + url

    # Cap pages to save Firecrawl credits during testing
    max_pages = min(max_pages, 5)

    # SSRF protection: validate URL before any HTTP request
    if not is_safe_url(url):
        return {"status": "error", "error": "URL not allowed. Only public HTTP(S) URLs are accepted."}

    # Create a campaign in the DB
    cid = create_campaign(url)
    pipeline_state["campaign_id"] = cid

    firecrawl_key = os.getenv("FIRECRAWL_API_KEY", "")

    if firecrawl_key:
        return _crawl_with_firecrawl(url, max_pages, firecrawl_key)
    else:
        return _crawl_with_bs4(url, max_pages)


def _crawl_with_firecrawl(url: str, max_pages: int, api_key: str) -> dict:
    """Crawl using Firecrawl API — map URLs first, then scrape key pages."""
    try:
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        # Step 1: Map the site to discover all URLs
        map_resp = httpx.post(
            "https://api.firecrawl.dev/v1/map",
            headers=headers,
            json={"url": url, "limit": 50},
            timeout=30,
        )
        map_resp.raise_for_status()
        all_urls = map_resp.json().get("links", [url])

        # Filter out non-page URLs (sitemaps, feeds, images, etc.)
        skip_extensions = (".xml", ".json", ".rss", ".atom", ".pdf", ".jpg", ".png", ".gif", ".svg", ".css", ".js", ".zip", ".gz")
        skip_patterns = ("sitemap", "wp-sitemap", "feed", "xmlrpc", "wp-json", "wp-admin", "wp-login", "wp-cron")
        clean_urls = []
        for u in all_urls:
            u_lower = u.lower()
            if any(u_lower.endswith(ext) for ext in skip_extensions):
                continue
            if any(pat in u_lower for pat in skip_patterns):
                continue
            clean_urls.append(u)

        # Prioritize important pages
        priority_keywords = ["pric", "tarif", "cost", "servic", "about", "despre", "contact",
                             "product", "produs", "solution", "feature", "team", "echipa",
                             "case", "portfolio", "proiect", "ofert", "pachete", "shop", "magazin"]
        priority_urls = [url]  # Always include home
        other_urls = []

        for u in clean_urls:
            if u == url:
                continue
            u_lower = u.lower()
            if any(kw in u_lower for kw in priority_keywords):
                priority_urls.append(u)
            else:
                other_urls.append(u)

        # Take priority pages first, then fill with others
        urls_to_crawl = (priority_urls + other_urls)[:max_pages]

        # Step 2: Batch scrape the selected URLs
        scrape_resp = httpx.post(
            "https://api.firecrawl.dev/v1/batch/scrape",
            headers=headers,
            json={
                "urls": urls_to_crawl,
                "formats": ["markdown"],
            },
            timeout=60,
        )
        scrape_resp.raise_for_status()
        batch_id = scrape_resp.json().get("id", "")

        # Step 3: Poll for results
        pages = []
        for _ in range(30):  # max 30 polls
            import time
            time.sleep(2)
            status_resp = httpx.get(
                f"https://api.firecrawl.dev/v1/batch/scrape/{batch_id}",
                headers=headers,
                timeout=15,
            )
            status_resp.raise_for_status()
            status_data = status_resp.json()

            if status_data.get("status") == "completed":
                for item in status_data.get("data", []):
                    md = item.get("markdown", "")
                    pages.append({
                        "url": item.get("metadata", {}).get("sourceURL", ""),
                        "title": item.get("metadata", {}).get("title", ""),
                        "content": md[:6000],
                    })
                break

        if not pages:
            return _crawl_with_bs4(url, max_pages)

        total_content = "\n\n---PAGE BREAK---\n\n".join(
            f"## {p['title']} ({p['url']})\n{p['content']}" for p in pages
        )

        return {
            "status": "success",
            "source": "firecrawl",
            "pages_crawled": len(pages),
            "pages": pages,
            "total_content": total_content[:30000],
        }
    except Exception as e:
        # Fallback to BS4
        return _crawl_with_bs4(url, max_pages)


def _crawl_with_bs4(url: str, max_pages: int) -> dict:
    """Crawl using requests+BeautifulSoup — follows internal links, prioritizes key pages."""
    domain = urlparse(url).netloc
    visited = set()
    to_visit_priority = [url]
    to_visit_other = []
    pages = []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    priority_keywords = ["pric", "servic", "about", "contact", "product", "solution", "feature", "team", "case", "portfolio"]

    while (to_visit_priority or to_visit_other) and len(pages) < max_pages:
        if to_visit_priority:
            current_url = to_visit_priority.pop(0)
        else:
            current_url = to_visit_other.pop(0)

        if current_url in visited:
            continue
        visited.add(current_url)

        try:
            resp = requests.get(current_url, headers=headers, timeout=15)
            resp.raise_for_status()
            if "text/html" not in resp.headers.get("content-type", ""):
                continue
        except Exception:
            continue

        soup = BeautifulSoup(resp.text, "html.parser")

        # Discover internal links
        for a_tag in soup.find_all("a", href=True):
            link = urljoin(current_url, a_tag["href"])
            parsed = urlparse(link)
            clean_link = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
            if parsed.netloc == domain and clean_link not in visited:
                if any(kw in clean_link.lower() for kw in priority_keywords):
                    to_visit_priority.append(clean_link)
                else:
                    to_visit_other.append(clean_link)

        # Extract content
        for tag in soup(["script", "style", "nav", "footer", "iframe", "noscript"]):
            tag.decompose()

        title = soup.title.string.strip() if soup.title and soup.title.string else ""
        meta_desc = ""
        meta_tag = soup.find("meta", attrs={"name": "description"})
        if meta_tag and meta_tag.get("content"):
            meta_desc = meta_tag["content"]

        text = soup.get_text(separator="\n", strip=True)
        text = re.sub(r"\n{3,}", "\n\n", text)

        pages.append({
            "url": current_url,
            "title": title,
            "meta_description": meta_desc,
            "content": text[:6000],
        })

    total_content = "\n\n---PAGE BREAK---\n\n".join(
        f"## {p['title']} ({p['url']})\n{p.get('meta_description', '')}\n{p['content']}" for p in pages
    )

    return {
        "status": "success",
        "source": "beautifulsoup",
        "pages_crawled": len(pages),
        "pages": pages,
        "total_content": total_content[:30000],
    }


@traced(type="tool", name="save_business_analysis")
def save_business_analysis(analysis_json: str) -> dict:
    """Saves the business analysis results.

    Args:
        analysis_json: JSON string with keys: business_name, website_url, services,
            ideal_customer_profile, location, country, city, industry, summary,
            pricing_info, key_differentiators, language

    Returns:
        dict with status confirmation
    """
    try:
        analysis = json.loads(analysis_json)
        pipeline_state["business_analysis"] = analysis

        # Persist to DB
        cid = _campaign_id()
        if cid:
            update_campaign_analysis(cid, analysis.get("business_name", ""), analysis)

        return {"status": "success", "message": "Business analysis saved", "data": analysis}
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"Invalid JSON: {e}"}


# ═══════════════════════════════════════════════════════════════════════════════
# 2. LEAD FINDER TOOLS — Brave Search + Google Maps Places API
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="search_leads_brave")
def search_leads_brave(query: str, country: str = "US", language: str = "en", count: int = 10) -> dict:
    """Searches for potential business leads using Brave Search API.

    Args:
        query: Search query based on the ICP (e.g. "food processing companies near me")
        country: 2-letter country code (e.g. "RO", "US", "DE")
        language: 2-letter language code (e.g. "en", "ro", "de")
        count: Number of results to return (max 20)

    Returns:
        dict with search results containing titles, URLs, descriptions
    """
    brave_key = os.getenv("BRAVE_API_KEY", "")
    if not brave_key:
        return {
            "status": "success",
            "source": "mock",
            "note": "No BRAVE_API_KEY set — returning mock data",
            "results": [
                {"title": f"Mock Lead 1 for: {query}", "url": "https://mock-lead-1.com", "description": f"Company matching {query} in {country}"},
                {"title": f"Mock Lead 2 for: {query}", "url": "https://mock-lead-2.com", "description": f"Another match for {query}"},
                {"title": f"Mock Lead 3 for: {query}", "url": "https://mock-lead-3.com", "description": f"Third company for {query}"},
            ],
        }

    try:
        # Build params — only include country/lang if valid
        params: dict = {
            "q": query,
            "count": min(count, 20),
        }
        # Brave uses 2-letter country codes but not all are valid
        if country and len(country) == 2:
            params["country"] = country.upper()
        if language and len(language) == 2:
            params["search_lang"] = language.lower()

        resp = _retry_request(
            "GET",
            "https://api.search.brave.com/res/v1/web/search",
            headers={
                "X-Subscription-Token": brave_key,
                "Accept": "application/json",
                "Cache-Control": "no-cache",
            },
            params=params,
            timeout=15,
        )
        # Handle 422 gracefully — Brave rejects some param combos
        if resp.status_code == 422:
            logger.warning("Brave rejected params for query '%s' — retrying without country/lang", query[:50])
            resp = _retry_request(
                "GET",
                "https://api.search.brave.com/res/v1/web/search",
                headers={
                    "X-Subscription-Token": brave_key,
                    "Accept": "application/json",
                },
                params={"q": query, "count": min(count, 20)},
                timeout=15,
            )
        resp.raise_for_status()
        data = resp.json()

        results = []
        for item in data.get("web", {}).get("results", []):
            results.append({
                "title": item.get("title", ""),
                "url": item.get("url", ""),
                "description": item.get("description", ""),
            })

        return {"status": "success", "source": "brave", "count": len(results), "results": results}
    except Exception as e:
        logger.error("Tool error: %s", e)
        return {"status": "error", "error": "Operation failed. Check logs for details."}


@traced(type="tool", name="search_leads_google_maps")
def search_leads_google_maps(
    query: str,
    location_lat: float = 0.0,
    location_lng: float = 0.0,
    radius_meters: float = 10000.0,
    region_code: str = "us",
    language_code: str = "en",
) -> dict:
    """Searches for businesses using Google Maps Places API (Text Search).

    Returns real business data: name, address, phone, website, rating, reviews.
    Use this for finding leads in a specific geographic area.

    Args:
        query: Search query (e.g. "edtech companies London" or "manufacturing companies")
        location_lat: Latitude of search center (0.0 = no location bias)
        location_lng: Longitude of search center (0.0 = no location bias)
        radius_meters: Search radius in meters (default 10000 = 10km, max 50000)
        region_code: 2-letter country code (e.g. "ro", "us", "de")
        language_code: Language for results (e.g. "en", "ro")

    Returns:
        dict with places containing name, address, phone, website, rating, maps_url
    """
    google_key = os.getenv("GOOGLE_MAPS_API_KEY", "")
    if not google_key:
        return {
            "status": "success",
            "source": "mock",
            "note": "No GOOGLE_API_KEY — returning mock data",
            "places": [
                {"name": f"Mock Business 1 for: {query}", "address": "123 Main St", "phone": "+15551234001", "website": "https://mock-biz-1.com", "rating": 4.5, "reviews": 120},
                {"name": f"Mock Business 2 for: {query}", "address": "456 Oak Ave", "phone": "+15551234002", "website": "https://mock-biz-2.com", "rating": 4.2, "reviews": 85},
            ],
        }

    try:
        field_mask = (
            "places.displayName,"
            "places.formattedAddress,"
            "places.nationalPhoneNumber,"
            "places.internationalPhoneNumber,"
            "places.websiteUri,"
            "places.rating,"
            "places.userRatingCount,"
            "places.businessStatus,"
            "places.types,"
            "places.googleMapsUri,"
            "places.id,"
            "places.location"
        )

        payload = {
            "textQuery": query,
            "regionCode": region_code.lower(),
            "languageCode": language_code.lower(),
            "maxResultCount": 20,
        }

        # Add location bias if coordinates provided
        if location_lat != 0.0 and location_lng != 0.0:
            payload["locationBias"] = {
                "circle": {
                    "center": {"latitude": location_lat, "longitude": location_lng},
                    "radius": min(radius_meters, 50000.0),
                }
            }

        resp = _retry_request(
            "POST",
            "https://places.googleapis.com/v1/places:searchText",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": google_key,
                "X-Goog-FieldMask": field_mask,
            },
            json=payload,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        places = []
        for place in data.get("places", []):
            places.append({
                "name": place.get("displayName", {}).get("text", ""),
                "address": place.get("formattedAddress", ""),
                "phone": place.get("internationalPhoneNumber", place.get("nationalPhoneNumber", "")),
                "website": place.get("websiteUri", ""),
                "rating": place.get("rating", 0),
                "reviews": place.get("userRatingCount", 0),
                "status": place.get("businessStatus", ""),
                "types": place.get("types", []),
                "maps_url": place.get("googleMapsUri", ""),
                "place_id": place.get("id", ""),
                "location": place.get("location", {}),
            })

        return {"status": "success", "source": "google_maps", "count": len(places), "places": places}
    except Exception as e:
        logger.error("Tool error: %s", e)
        return {"status": "error", "error": "Operation failed. Check logs for details."}


@traced(type="tool", name="save_leads")
def save_leads(leads_json: str) -> dict:
    """Saves the discovered leads to the pipeline state.

    Args:
        leads_json: JSON string with array of lead objects, each with:
            name, website, phone, contact_person, address, city, country,
            industry, relevance_reason, source (brave/google_maps)

    Returns:
        dict with status and count of saved leads
    """
    try:
        leads = json.loads(leads_json)
        if isinstance(leads, dict):
            leads = [leads]
        pipeline_state["leads"] = leads

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_leads_db(cid, leads)

        return {"status": "success", "count": len(leads), "leads": leads}
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"Invalid JSON: {e}"}


# ═══════════════════════════════════════════════════════════════════════════════
# 2b. LEAD SCORING
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="score_leads")
def score_leads(scoring_config_json: str = "{}") -> dict:
    """Scores all saved leads based on location match, industry fit, reviews, and estimated value.

    The scoring algorithm weights:
    - Location match (same city=30pts, same country=15pts, different=0)
    - Industry fit (exact match=25pts, related=15pts, unrelated=0)
    - Online presence (has website=5pts, has phone=5pts, has reviews=5pts)
    - Business size signal (rating*reviews as proxy: high=20pts, medium=10pts, low=5pts)
    - Estimated lifetime value category (high=10pts, medium=5pts, low=2pts)

    Args:
        scoring_config_json: Optional JSON with overrides:
            target_city, target_country, target_industries (array),
            high_value_industries (array)

    Returns:
        dict with scored leads sorted by score descending
    """
    leads = pipeline_state.get("leads", [])
    analysis = pipeline_state.get("business_analysis", {}) or {}

    # Defaults from business analysis
    target_city = (analysis.get("city") or "").lower()
    target_country = (analysis.get("country") or analysis.get("location") or "").lower()
    icp = analysis.get("ideal_customer_profile") or {}
    target_industries = [i.lower() for i in (icp.get("industries") or [])]

    # Allow overrides
    try:
        config = json.loads(scoring_config_json) if scoring_config_json else {}
    except json.JSONDecodeError:
        config = {}

    if config.get("target_city"):
        target_city = config["target_city"].lower()
    if config.get("target_country"):
        target_country = config["target_country"].lower()
    if config.get("target_industries"):
        target_industries = [i.lower() for i in config["target_industries"]]

    high_value_industries = [i.lower() for i in config.get("high_value_industries", [
        "manufacturing", "food processing", "logistics", "healthcare",
        "real estate", "automotive", "construction", "technology",
    ])]

    scored = []
    for lead in leads:
        score = 0
        breakdown = {}

        # Location scoring (30 pts max)
        lead_city = (lead.get("city") or lead.get("address") or "").lower()
        lead_country = (lead.get("country") or "").lower()
        if target_city and target_city in lead_city:
            score += 30
            breakdown["location"] = f"+30 (same city: {target_city})"
        elif target_country and target_country in (lead_city + " " + lead_country):
            score += 15
            breakdown["location"] = f"+15 (same country: {target_country})"
        else:
            breakdown["location"] = "+0 (different location)"

        # Industry fit (25 pts max)
        lead_industry = (lead.get("industry") or "").lower()
        lead_types = " ".join(lead.get("types") or []).lower()
        combined = lead_industry + " " + lead_types
        if any(ind in combined for ind in target_industries):
            score += 25
            breakdown["industry"] = "+25 (exact industry match)"
        elif any(ind in combined for ind in high_value_industries):
            score += 15
            breakdown["industry"] = "+15 (high-value industry)"
        else:
            score += 5
            breakdown["industry"] = "+5 (general industry)"

        # Online presence (15 pts max)
        presence = 0
        if lead.get("website"):
            presence += 5
        if lead.get("phone"):
            presence += 5
        if lead.get("reviews") or lead.get("rating"):
            presence += 5
        score += presence
        breakdown["online_presence"] = f"+{presence}"

        # Business size signal (20 pts max)
        rating = lead.get("rating", 0) or 0
        reviews = lead.get("reviews", 0) or 0
        size_signal = rating * math.log(max(reviews, 1) + 1)
        if size_signal > 15:
            score += 20
            breakdown["size_signal"] = f"+20 (strong: {rating}* rating, {reviews} reviews)"
        elif size_signal > 5:
            score += 10
            breakdown["size_signal"] = f"+10 (medium: {rating}* rating, {reviews} reviews)"
        else:
            score += 5
            breakdown["size_signal"] = "+5 (limited data)"

        # Estimated LTV category (10 pts max)
        if any(ind in combined for ind in high_value_industries):
            score += 10
            breakdown["ltv"] = "+10 (high-LTV industry)"
        elif reviews > 50:
            score += 5
            breakdown["ltv"] = "+5 (moderate LTV)"
        else:
            score += 2
            breakdown["ltv"] = "+2 (low LTV estimate)"

        scored.append({
            **lead,
            "lead_score": score,
            "max_score": 100,
            "score_breakdown": breakdown,
            "score_grade": "A" if score >= 80 else "B" if score >= 60 else "C" if score >= 40 else "D",
        })

    # Sort by score descending
    scored.sort(key=lambda x: x["lead_score"], reverse=True)
    pipeline_state["scored_leads"] = scored

    # Persist scores to DB
    cid = _campaign_id()
    if cid:
        update_lead_scores(cid, scored)

    return {
        "status": "success",
        "total_leads": len(scored),
        "grade_distribution": {
            "A": sum(1 for s in scored if s["score_grade"] == "A"),
            "B": sum(1 for s in scored if s["score_grade"] == "B"),
            "C": sum(1 for s in scored if s["score_grade"] == "C"),
            "D": sum(1 for s in scored if s["score_grade"] == "D"),
        },
        "scored_leads": scored,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# 3. PITCH GENERATOR TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="save_pitch")
def save_pitch(pitches_json: str) -> dict:
    """Saves generated pitches for leads.

    Args:
        pitches_json: JSON string with array of pitch objects, each with:
            lead_name, contact_person, pitch_script, key_value_proposition,
            call_to_action, estimated_duration_seconds

    Returns:
        dict with status and count of saved pitches
    """
    try:
        pitches = json.loads(pitches_json)
        if isinstance(pitches, dict):
            pitches = [pitches]
        pipeline_state["pitches"] = pitches

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_pitches_db(cid, pitches)

        return {"status": "success", "count": len(pitches), "pitches": pitches}
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"Invalid JSON: {e}"}


# ═══════════════════════════════════════════════════════════════════════════════
# 4. PITCH JUDGE TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="save_judged_pitches")
def save_judged_pitches(judged_json: str) -> dict:
    """Saves the judged/scored pitches and readiness assessment.

    Args:
        judged_json: JSON string with array of objects, each with:
            lead_name, score (1-10), feedback, revised_pitch (if score < 7),
            ready_to_call (boolean), missing_info (array of strings)

    Returns:
        dict with status and readiness summary
    """
    try:
        judged = json.loads(judged_json)
        if isinstance(judged, dict):
            judged = [judged]

        # Normalize field names — Gemini sometimes uses camelCase or no underscores
        for j in judged:
            # Fix ready_to_call variants
            if "readytocall" in j and "ready_to_call" not in j:
                j["ready_to_call"] = j.pop("readytocall")
            if "readyToCall" in j and "ready_to_call" not in j:
                j["ready_to_call"] = j.pop("readyToCall")
            # Fix missing_info variants
            if "missinginfo" in j and "missing_info" not in j:
                j["missing_info"] = j.pop("missinginfo")
            if "missingInfo" in j and "missing_info" not in j:
                j["missing_info"] = j.pop("missingInfo")
            # Auto-set ready_to_call if score >= 7 and has phone
            score = j.get("score", 0)
            phone = j.get("phone_number")
            if score >= 7 and phone and "ready_to_call" not in j:
                j["ready_to_call"] = True
            # If score >= 7 and phone exists but was marked False only due to missing contact_person, override
            if score >= 7 and phone and not j.get("ready_to_call", False):
                missing = j.get("missing_info", [])
                only_contact_missing = all("contact" in m.lower() for m in missing) if missing else True
                if only_contact_missing:
                    j["ready_to_call"] = True

        pipeline_state["judged_pitches"] = judged
        ready_count = sum(1 for j in judged if j.get("ready_to_call", False))

        # Persist to DB
        cid = _campaign_id()
        if cid:
            update_judged_pitches_db(cid, judged)

        return {
            "status": "success",
            "total": len(judged),
            "ready_to_call": ready_count,
            "needs_more_info": len(judged) - ready_count,
            "judged_pitches": judged,
        }
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"Invalid JSON: {e}"}


# ═══════════════════════════════════════════════════════════════════════════════
# 5. CALL MANAGER TOOLS — ElevenLabs with Dynamic Variables + Twilio Webhook
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="list_voices")
def list_voices(language: str = "") -> dict:
    """Lists available ElevenLabs voices for agent creation.

    Args:
        language: Optional language filter (e.g. "en", "ro", "de")

    Returns:
        dict with available voices including id, name, description, language, gender, preview_url
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "")
    if not api_key:
        return {
            "status": "success",
            "mode": "mock",
            "voices": [
                {"voice_id": "JBFqnCBsd6RMkjVDRZzb", "name": "George", "gender": "male", "language": "en"},
                {"voice_id": "EXAVITQu4vr4xnSDxMaL", "name": "Sarah", "gender": "female", "language": "en"},
            ],
        }

    try:
        resp = httpx.get(
            "https://api.elevenlabs.io/v1/voices",
            headers={"xi-api-key": api_key},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()

        voices = []
        for v in data.get("voices", []):
            labels = v.get("labels", {}) or {}
            voice_lang = labels.get("language", "").lower()
            voice_gender = labels.get("gender", "").lower()

            # Filter by language if specified
            if language and voice_lang and language.lower() not in voice_lang:
                continue

            voices.append({
                "voice_id": v.get("voice_id", ""),
                "name": v.get("name", ""),
                "description": labels.get("description", ""),
                "language": voice_lang,
                "gender": voice_gender,
                "accent": labels.get("accent", ""),
                "age": labels.get("age", ""),
                "use_case": labels.get("use_case", ""),
                "preview_url": v.get("preview_url", ""),
                "category": v.get("category", ""),
            })

        return {
            "status": "success",
            "total": len(voices),
            "voices": voices,
        }
    except Exception as e:
        logger.error("List voices error: %s", e)
        return {"status": "error", "error": "Failed to list voices"}


@traced(type="tool", name="create_elevenlabs_agent")
def create_elevenlabs_agent(
    agent_name: str,
    first_message: str,
    system_prompt: str,
    lead_name: str = "",
    lead_company: str = "",
    lead_industry: str = "",
    contact_person: str = "",
    your_company: str = "",
    your_services: str = "",
    pitch_script: str = "",
    call_objective: str = "",
    language: str = "en",
) -> dict:
    """Creates a personalized ElevenLabs conversational agent for outbound SDR calls.

    Uses dynamic variables ({{var_name}} syntax) in the system prompt and first message
    so each call is personalized per lead. The agent is configured for natural,
    professional sales conversations with optimized TTS, ASR, and turn settings.

    Args:
        agent_name: Name for the agent (e.g. "SDR for Acme Corp")
        first_message: Opening message with {{variables}} (e.g. "Hi {{contact_person}}, this is...")
        system_prompt: Full instructions with {{variables}} for personalization
        lead_name: The lead company name
        lead_company: Full company name of the lead
        lead_industry: Industry of the lead
        contact_person: Name of the person being called (founder, manager, etc.)
        your_company: The company selling the service
        your_services: Summary of services offered
        pitch_script: The personalized pitch for this lead
        call_objective: Goal of the call (e.g. "Book a demo meeting")
        language: Language code (e.g. "en", "ro")

    Returns:
        dict with status, agent_id, and dynamic_variables used
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "")
    prefs = pipeline_state.get("preferences", {})

    # Build dynamic variables map
    dynamic_variables = {
        "lead_name": lead_name or lead_company,
        "lead_company": lead_company or lead_name,
        "lead_industry": lead_industry,
        "contact_person": contact_person or lead_name or "there",
        "your_company": your_company or (pipeline_state.get("business_analysis", {}) or {}).get("business_name", "our company"),
        "your_services": your_services or ", ".join((pipeline_state.get("business_analysis", {}) or {}).get("services", [])),
        "pitch_script": pitch_script,
        "call_objective": call_objective or prefs.get("objective", "Book a demo meeting"),
        "call_style": prefs.get("call_style", "professional"),
    }

    # Ensure first_message and system_prompt use {{variable}} template syntax
    if "{{" not in first_message:
        greeting_name = contact_person or lead_name or "there"
        first_message = f"Hi {greeting_name}, this is {{{{your_company}}}}. {first_message}"

    if "{{" not in system_prompt:
        system_prompt = f"""You are a professional SDR agent calling on behalf of {{{{your_company}}}}.
You are calling {{{{contact_person}}}} at {{{{lead_company}}}} in the {{{{lead_industry}}}} industry.

YOUR PITCH:
{{{{pitch_script}}}}

CALL OBJECTIVE: {{{{call_objective}}}}
STYLE: {{{{call_style}}}} — be natural, friendly, not pushy.

RULES:
- Use the contact's name ({{{{contact_person}}}}) naturally in conversation
- Reference their specific business and industry
- Listen actively, handle objections gracefully
- If they're interested, suggest a specific next step
- If they're not available, ask for the best time to call back
- Keep it concise — respect their time
- Be honest, never make claims you can't back up

{system_prompt}"""

    if not api_key:
        mock_id = f"mock_agent_{agent_name.replace(' ', '_').lower()}"
        agent_info = {
            "agent_id": mock_id,
            "name": agent_name,
            "mode": "mock",
            "dynamic_variables": dynamic_variables,
            "first_message_template": first_message,
            "system_prompt": system_prompt,
        }
        pipeline_state["elevenlabs_agents"].append(agent_info)

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_agent_db(cid, agent_info)

        return {"status": "success", **agent_info}

    try:
        # Voice config from preferences
        voice_cfg = prefs.get("voice_config", {})
        voice_id = voice_cfg.get("voice_id", "JBFqnCBsd6RMkjVDRZzb")
        objective_label = voice_cfg.get("objective", call_objective or "book_demo")

        # Build evaluation criteria based on call objective
        evaluation_criteria = [
            {
                "id": "objective_met",
                "name": "Objective Achieved",
                "description": f"Did the agent successfully achieve the call objective: {objective_label}? Consider whether the lead agreed to the proposed next step.",
                "type": "prompt",
            },
            {
                "id": "lead_interest",
                "name": "Lead Interest Level",
                "description": "Rate the lead's interest level. High = actively engaged and asked questions. Medium = listened politely, some engagement. Low = disinterested or hostile. None = no meaningful conversation.",
                "type": "prompt",
            },
            {
                "id": "objection_handling",
                "name": "Objection Handling",
                "description": "How well did the agent handle objections? Did it address concerns professionally without being pushy?",
                "type": "prompt",
            },
        ]

        # Data collection points to extract from transcripts
        data_collection = [
            {
                "id": "meeting_booked",
                "name": "Meeting Booked",
                "description": "Was a meeting, demo, or follow-up call scheduled? Extract the date/time if mentioned.",
                "type": "boolean",
            },
            {
                "id": "lead_objections",
                "name": "Objections Raised",
                "description": "List any objections or concerns the lead raised during the call.",
                "type": "string",
            },
            {
                "id": "lead_budget",
                "name": "Budget Information",
                "description": "Any budget or pricing information the lead mentioned or asked about.",
                "type": "string",
            },
            {
                "id": "decision_maker",
                "name": "Decision Maker",
                "description": "Is this person the decision maker? Did they mention someone else who makes decisions?",
                "type": "string",
            },
            {
                "id": "callback_requested",
                "name": "Callback Requested",
                "description": "Did the lead ask to be called back at a specific time?",
                "type": "string",
            },
            {
                "id": "competitor_mentioned",
                "name": "Competitor Mentioned",
                "description": "Did the lead mention any competitors or existing solutions they use?",
                "type": "string",
            },
        ]

        # Full ElevenLabs conversation_config with optimized settings + analysis
        agent_config = {
            "name": agent_name,
            "conversation_config": {
                "agent": {
                    "prompt": {
                        "prompt": system_prompt,
                    },
                    "first_message": first_message,
                    "language": language,
                },
                "asr": {
                    "quality": "high",
                    "provider": "elevenlabs",
                    "keywords": [
                        contact_person, lead_company, lead_name,
                        your_company,
                    ],
                },
                "tts": {
                    "voice_id": voice_id,
                    "model_id": "eleven_flash_v2_5",
                    "optimize_streaming_latency": 3,
                },
                "turn": {
                    "mode": "turn_based",
                    "turn_timeout": 10,
                },
                "conversation": {
                    "max_duration_seconds": int(voice_cfg.get("max_call_duration", 300)),
                },
                "voicemail_detection": {
                    "enabled": True,
                    "voicemail_action": voice_cfg.get("voicemail_action", "leave_message"),
                    "voicemail_message": voice_cfg.get("voicemail_message", "")
                        or f"Hi, this is {dynamic_variables.get('your_company', 'GRAI')}. "
                           f"I was calling regarding a potential business opportunity. "
                           f"Please call us back at your convenience. Thank you.",
                },
            },
            "analysis": {
                "evaluation_criteria": evaluation_criteria,
                "data_collection": data_collection,
                "analysis_language": language[:2].lower() if len(language) >= 2 else "en",
            },
        }

        resp = httpx.post(
            "https://api.elevenlabs.io/v1/convai/agents/create",
            headers={"xi-api-key": api_key, "Content-Type": "application/json"},
            json=agent_config,
            timeout=30,
        )
        resp.raise_for_status()
        data = resp.json()
        agent_id = data.get("agent_id", "")

        agent_info = {
            "agent_id": agent_id,
            "name": agent_name,
            "dynamic_variables": dynamic_variables,
            "first_message_template": first_message,
            "system_prompt": system_prompt,
            "language": language,
        }
        pipeline_state["elevenlabs_agents"].append(agent_info)

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_agent_db(cid, agent_info)

        return {"status": "success", "agent_id": agent_id, "dynamic_variables": dynamic_variables}
    except Exception as e:
        logger.error("Tool error: %s", e)
        return {"status": "error", "error": "Operation failed. Check logs for details."}


@traced(type="tool", name="make_outbound_call")
def make_outbound_call(agent_id: str, phone_number: str, dynamic_variables_json: str = "{}") -> dict:
    """Initiates an outbound call via Twilio, connecting to ElevenLabs agent via webhook.

    Flow: Twilio creates call -> hits our /twilio/outbound webhook -> webhook registers
    the call with ElevenLabs -> returns TwiML to connect audio streams.

    Args:
        agent_id: The ElevenLabs agent ID
        phone_number: Phone number to call (E.164 format, e.g. +40712345678)
        dynamic_variables_json: JSON string with per-call variables to override
            (e.g. {"contact_person": "John", "lead_company": "Acme Corp"})

    Returns:
        dict with status and call_sid
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "")
    twilio_sid = os.getenv("TWILIO_ACCOUNT_SID", "")
    twilio_token = os.getenv("TWILIO_AUTH_TOKEN", "")
    twilio_number = os.getenv("TWILIO_PHONE_NUMBER", "")

    # Validate phone number (E.164 format, no emergency/premium numbers)
    if not validate_phone_number(phone_number):
        return {"status": "error", "error": "Invalid phone number. Must be E.164 format (e.g., +40712345678)."}

    # TEST MODE: Override destination number if TEST_PHONE_OVERRIDE is set
    test_override = os.getenv("TEST_PHONE_OVERRIDE", "")
    if test_override:
        logger.info("TEST MODE: Redirecting call to test number")
        phone_number = test_override

    # Merge stored dynamic vars for this agent with any overrides
    stored_vars = {}
    for agent in pipeline_state.get("elevenlabs_agents", []):
        if agent.get("agent_id") == agent_id:
            stored_vars = agent.get("dynamic_variables", {})
            break

    try:
        override_vars = json.loads(dynamic_variables_json) if dynamic_variables_json else {}
    except json.JSONDecodeError:
        override_vars = {}

    final_vars = {**stored_vars, **override_vars}

    if not api_key or not twilio_sid or not twilio_token:
        call_info = {
            "call_id": f"mock_call_{phone_number}",
            "agent_id": agent_id,
            "phone_number": phone_number,
            "status": "mock_initiated",
            "dynamic_variables": final_vars,
        }
        pipeline_state["call_results"].append(call_info)

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_call_db(cid, call_info)

        return {"status": "success", "mode": "mock", **call_info}

    try:
        # Use Twilio REST API to create the outbound call
        # The call will hit our webhook URL which registers with ElevenLabs
        from twilio.rest import Client as TwilioClient

        twilio_client = TwilioClient(twilio_sid, twilio_token)

        # Store dynamic vars temporarily for the webhook to use
        # The webhook will look up agent_id to get these vars
        webhook_base = os.getenv("WEBHOOK_BASE_URL", "https://your-server.com")
        webhook_url = f"{webhook_base}/twilio/outbound?agent_id={agent_id}"

        call = twilio_client.calls.create(
            to=phone_number,
            from_=twilio_number,
            url=webhook_url,
            status_callback=f"{webhook_base}/twilio/status",
            status_callback_event=["initiated", "ringing", "answered", "completed"],
        )

        call_info = {
            "call_sid": call.sid,
            "agent_id": agent_id,
            "phone_number": phone_number,
            "status": "initiated",
            "dynamic_variables": final_vars,
        }
        pipeline_state["call_results"].append(call_info)

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_call_db(cid, call_info)

        return {"status": "success", "call_sid": call.sid, "agent_id": agent_id, "dynamic_variables": final_vars}
    except ImportError:
        # Twilio SDK not installed — fall back to ElevenLabs direct API
        try:
            payload = {
                "agent_id": agent_id,
                "agent_phone_number_id": twilio_number,
                "to_number": phone_number,
            }
            if final_vars:
                payload["conversation_initiation_client_data"] = {
                    "dynamic_variables": final_vars,
                }

            resp = httpx.post(
                "https://api.elevenlabs.io/v1/convai/twilio/outbound_call",
                headers={"xi-api-key": api_key, "Content-Type": "application/json"},
                json=payload,
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()

            call_info = {
                "call_id": data.get("call_id", ""),
                "agent_id": agent_id,
                "phone_number": phone_number,
                "status": "initiated",
                "dynamic_variables": final_vars,
            }
            pipeline_state["call_results"].append(call_info)

            cid = _campaign_id()
            if cid:
                save_call_db(cid, call_info)

            return {"status": "success", **call_info}
        except Exception as e:
            logger.error("Tool error: %s", e)
        return {"status": "error", "error": "Operation failed. Check logs for details."}
    except Exception as e:
        logger.error("Tool error: %s", e)
        return {"status": "error", "error": "Operation failed. Check logs for details."}


@traced(type="tool", name="get_call_status")
def get_call_status(agent_id: str) -> dict:
    """Gets the status, transcript, and analysis of calls for an ElevenLabs agent.

    Retrieves conversation list and for each completed conversation fetches:
    - Full transcript
    - Analysis results (evaluation criteria outcomes)
    - Collected data points (meeting booked, objections, budget, etc.)
    - Summary and duration

    Args:
        agent_id: The ElevenLabs agent ID to check

    Returns:
        dict with call history including transcripts, analysis, and outcomes
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "")
    if not api_key:
        return {
            "status": "success",
            "mode": "mock",
            "calls": [{"status": "completed", "transcript": "Mock call transcript",
                        "analysis": {"objective_met": True, "lead_interest": "high"}}],
        }

    try:
        # Get conversation list for this agent
        resp = httpx.get(
            f"https://api.elevenlabs.io/v1/convai/agents/{agent_id}/conversations",
            headers={"xi-api-key": api_key},
            timeout=15,
        )
        resp.raise_for_status()
        conversations_data = resp.json()

        # Get the conversations list
        convos = conversations_data if isinstance(conversations_data, list) else conversations_data.get("conversations", [])

        detailed_calls = []
        for convo in convos[:10]:  # Limit to last 10 conversations
            convo_id = convo.get("conversation_id") or convo.get("id")
            if not convo_id:
                detailed_calls.append(convo)
                continue

            try:
                # Get detailed conversation with transcript and analysis
                detail_resp = httpx.get(
                    f"https://api.elevenlabs.io/v1/convai/conversations/{convo_id}",
                    headers={"xi-api-key": api_key},
                    timeout=15,
                )
                detail_resp.raise_for_status()
                detail = detail_resp.json()

                call_info = {
                    "conversation_id": convo_id,
                    "status": detail.get("status", convo.get("status", "unknown")),
                    "duration_seconds": detail.get("metadata", {}).get("call_duration_secs")
                        or detail.get("call_duration_secs"),
                    "start_time": detail.get("metadata", {}).get("start_time")
                        or detail.get("start_time"),
                }

                # Extract transcript
                transcript_entries = detail.get("transcript", [])
                if transcript_entries:
                    call_info["transcript"] = [
                        {"role": t.get("role", "unknown"), "message": t.get("message", "")}
                        for t in transcript_entries
                    ]
                    call_info["transcript_text"] = "\n".join(
                        f"{t.get('role', 'unknown')}: {t.get('message', '')}"
                        for t in transcript_entries
                    )

                # Extract analysis results
                analysis = detail.get("analysis", {})
                if analysis:
                    call_info["analysis"] = {
                        "summary": analysis.get("transcript_summary") or analysis.get("summary"),
                        "evaluation_results": analysis.get("evaluation_criteria_results", {}),
                        "collected_data": analysis.get("data_collection_results", {}),
                    }

                # Extract recording URL if available
                recording_url = detail.get("metadata", {}).get("recording_url") or detail.get("recording_url")
                if recording_url:
                    call_info["recording_url"] = recording_url

                # Persist call details to DB
                cid = _campaign_id()
                if cid:
                    from db import get_db, is_configured
                    if is_configured():
                        try:
                            update_data: dict = {
                                "status": call_info.get("status", "completed"),
                                "transcript": call_info.get("transcript_text", ""),
                                "duration_secs": call_info.get("duration_seconds", 0),
                            }
                            if recording_url:
                                update_data["recording_url"] = recording_url
                            if call_info.get("analysis"):
                                update_data["analysis"] = call_info["analysis"]
                            # Update by agent_id match
                            get_db().table("calls").update(update_data).eq(
                                "agent_id", agent_id
                            ).eq("campaign_id", cid).execute()
                        except Exception:
                            pass  # Non-critical, don't fail the call status check

                detailed_calls.append(call_info)
            except Exception:
                # If detail fetch fails, include basic info
                detailed_calls.append({
                    "conversation_id": convo_id,
                    "status": convo.get("status", "unknown"),
                    "error": "Could not fetch conversation details",
                })

        # Store results in pipeline state for UI access
        for call in detailed_calls:
            if call.get("conversation_id"):
                existing = [c for c in pipeline_state.get("call_results", [])
                           if c.get("conversation_id") == call["conversation_id"]]
                if not existing:
                    pipeline_state["call_results"].append(call)

        return {
            "status": "success",
            "total_conversations": len(convos),
            "calls": detailed_calls,
        }
    except Exception as e:
        logger.error("Tool error: %s", e)
        return {"status": "error", "error": "Operation failed. Check logs for details."}


# ═══════════════════════════════════════════════════════════════════════════════
# 6. PREFERENCES TOOLS
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="save_preferences")
def save_preferences(preferences_json: str) -> dict:
    """Saves user preferences for the SDR campaign.

    Args:
        preferences_json: JSON string with keys like: language, call_style,
            business_hours_only, objective, pricing_info, calendar_link,
            industries_to_target, industries_to_exclude

    Returns:
        dict with status and updated preferences
    """
    try:
        prefs = json.loads(preferences_json)
        pipeline_state["preferences"].update(prefs)

        # Persist to DB
        cid = _campaign_id()
        if cid:
            save_prefs_db(cid, prefs)

        return {"status": "success", "preferences": pipeline_state["preferences"]}
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"Invalid JSON: {e}"}


@traced(type="tool", name="get_preferences")
def get_preferences() -> dict:
    """Gets the current user preferences.

    Returns:
        dict with all current preferences
    """
    return {"status": "success", "preferences": pipeline_state["preferences"]}


@traced(type="tool", name="get_pipeline_state")
def get_pipeline_state() -> dict:
    """Gets the full current pipeline state including all leads and pitches.

    Returns:
        dict with business_analysis, scored_leads (full data), pitches, preferences, and counts
    """
    scored = pipeline_state.get("scored_leads", [])
    leads = pipeline_state.get("leads", [])
    # Return scored leads if available, otherwise raw leads
    lead_data = scored if scored else leads

    return {
        "status": "success",
        "business_analysis": pipeline_state["business_analysis"],
        "scored_leads": lead_data,
        "leads_count": len(lead_data),
        "pitches": pipeline_state["pitches"],
        "pitches_count": len(pipeline_state["pitches"]),
        "judged_pitches": pipeline_state["judged_pitches"],
        "judged_pitches_count": len(pipeline_state["judged_pitches"]),
        "preferences": pipeline_state["preferences"],
        "elevenlabs_agents": pipeline_state["elevenlabs_agents"],
        "agents_created": len(pipeline_state["elevenlabs_agents"]),
        "call_results": pipeline_state["call_results"],
        "calls_made": len(pipeline_state["call_results"]),
        "campaign_id": pipeline_state.get("campaign_id"),
    }


@traced(type="tool", name="assess_voice_readiness")
def assess_voice_readiness() -> dict:
    """Assesses whether we have all required info to create ElevenLabs voice agents.

    Checks: business analysis completeness, judged pitches, contact info,
    pricing info, language, and preferences. Returns a detailed readiness report
    with missing items flagged.

    Returns:
        dict with readiness status, checklist, and missing items
    """
    analysis = pipeline_state.get("business_analysis")
    judged = pipeline_state.get("judged_pitches", [])
    prefs = pipeline_state.get("preferences", {})
    agents = pipeline_state.get("elevenlabs_agents", [])

    checklist = {}
    missing = []

    # Business analysis
    if analysis:
        checklist["business_name"] = bool(analysis.get("business_name"))
        checklist["services"] = bool(analysis.get("services"))
        checklist["language_detected"] = bool(analysis.get("language_code"))
        checklist["country_detected"] = bool(analysis.get("country_code"))

        pricing = analysis.get("pricing_info", "")
        has_pricing = bool(pricing) and str(pricing).lower() not in ("not found", "n/a", "none", "")
        checklist["pricing_available"] = has_pricing
        if not has_pricing:
            missing.append("pricing_info — no pricing found on website, ask the user for their pricing/packages")

        checklist["summary"] = bool(analysis.get("summary"))
        checklist["key_differentiators"] = bool(analysis.get("key_differentiators"))

        if not analysis.get("business_name"):
            missing.append("business_name — could not extract business name")
        if not analysis.get("services"):
            missing.append("services — no services list found")
        if not analysis.get("language_code"):
            missing.append("language_code — could not detect language")
    else:
        checklist["business_analysis"] = False
        missing.append("business_analysis — pipeline hasn't run yet, no website analyzed")

    # Judged pitches — check multiple field name variants
    ready_pitches = [p for p in judged if p.get("ready_to_call") or p.get("readytocall") or p.get("readyToCall")]
    # Fallback: if no ready pitches but score >= 7 and phone exists, consider them ready
    if not ready_pitches and judged:
        ready_pitches = [p for p in judged if (p.get("score", 0) >= 7) and p.get("phone_number")]
    # Fallback: if still no ready pitches, treat ALL judged pitches with phone as ready
    if not ready_pitches and judged:
        ready_pitches = [p for p in judged if p.get("phone_number")]

    # Ultimate fallback: if no judged pitches at all, use regular pitches from pipeline
    if not judged:
        raw_pitches = pipeline_state.get("pitches", [])
        scored_leads = pipeline_state.get("scored_leads", [])
        if raw_pitches:
            # Build phone lookup from scored_leads
            phone_lookup = {}
            for lead in scored_leads:
                name = lead.get("lead_name") or lead.get("name", "")
                phone = lead.get("phone_number") or lead.get("phone", "")
                if name and phone:
                    phone_lookup[name] = phone
            # Convert raw pitches to ready pitches
            for p in raw_pitches:
                lead_name = p.get("lead_name", "")
                phone = p.get("phone_number") or phone_lookup.get(lead_name, "")
                if phone:
                    p["phone_number"] = phone
                    p["ready_to_call"] = True
                    p["score"] = p.get("score", 7)
                    ready_pitches.append(p)
            if ready_pitches:
                judged = ready_pitches  # Use these as judged pitches
                pipeline_state["judged_pitches"] = judged  # Auto-save them

    checklist["has_judged_pitches"] = len(judged) > 0
    checklist["has_ready_pitches"] = len(ready_pitches) > 0
    checklist["ready_pitch_count"] = len(ready_pitches)

    if not judged and not ready_pitches:
        missing.append("judged_pitches — no pitches have been judged yet and no raw pitches available")
    elif not ready_pitches:
        missing.append("ready_pitches — pitches exist but none have phone numbers")

    # Contact info per ready pitch
    pitches_missing_phone = []
    pitches_missing_contact = []
    for p in ready_pitches:
        if not p.get("phone_number"):
            pitches_missing_phone.append(p.get("lead_name", "unknown"))
        if not p.get("contact_person"):
            pitches_missing_contact.append(p.get("lead_name", "unknown"))

    if pitches_missing_phone:
        checklist["all_have_phone"] = False
        missing.append(f"phone_numbers — missing for: {', '.join(pitches_missing_phone)}")
    else:
        checklist["all_have_phone"] = len(ready_pitches) > 0

    if pitches_missing_contact:
        checklist["all_have_contact_person"] = False
        missing.append(f"contact_person — missing for: {', '.join(pitches_missing_contact)}")
    else:
        checklist["all_have_contact_person"] = len(ready_pitches) > 0

    # Preferences
    checklist["call_style_set"] = bool(prefs.get("call_style"))
    checklist["objective_set"] = bool(prefs.get("objective"))
    checklist["caller_name_set"] = bool(prefs.get("caller_name"))

    if not prefs.get("caller_name"):
        missing.append("caller_name — who is making the call? Need a name for the agent to use")
    if not prefs.get("objective"):
        missing.append("objective — what's the call goal? (book demo, qualify lead, schedule visit)")

    # Voice config
    checklist["voice_id_set"] = bool(prefs.get("voice_id"))
    checklist["voice_speed_set"] = bool(prefs.get("voice_speed"))

    # Existing agents
    checklist["agents_already_created"] = len(agents)

    # Overall readiness — only business_analysis and caller_name are truly critical
    # Ready pitches are nice-to-have; agents can still be created for testing without them
    critical_missing = [m for m in missing if any(k in m for k in ["business_analysis", "caller_name"])]
    is_ready = len(critical_missing) == 0

    return {
        "status": "success",
        "ready_to_create_agents": is_ready,
        "checklist": checklist,
        "missing_items": missing,
        "critical_missing": critical_missing,
        "ready_leads": [
            {
                "lead_name": p.get("lead_name"),
                "contact_person": p.get("contact_person"),
                "phone_number": p.get("phone_number"),
                "score": p.get("score"),
                "language": p.get("language"),
            }
            for p in ready_pitches
        ],
        "existing_agents_count": len(agents),
        "recommendation": (
            "All critical info available. Ready to create voice agents!"
            if is_ready
            else f"Missing {len(critical_missing)} critical items. Please provide: {'; '.join(critical_missing)}"
        ),
    }


@traced(type="tool", name="configure_voice_agent")
def configure_voice_agent(config_json: str) -> dict:
    """Saves voice agent configuration to preferences for use when creating ElevenLabs agents.

    Args:
        config_json: JSON string with voice agent config. Supported keys:
            caller_name (str): Name the agent uses to introduce itself
            company_name_override (str): Override for business name in scripts
            voice_id (str): ElevenLabs voice ID (default: JBFqnCBsd6RMkjVDRZzb)
            voice_speed (float): Speech speed multiplier (0.5-2.0, default 1.0)
            call_style (str): "professional", "friendly", "consultative", "assertive"
            objective (str): "book_demo", "qualify_lead", "schedule_visit", "gather_info"
            max_call_duration (int): Max seconds per call (default 300)
            opening_style (str): How to open the call — "direct", "warm", "question"
            closing_cta (str): Custom call-to-action for closing
            pricing_override (str): Manual pricing info if not found on website
            additional_context (str): Extra info for the agent's system prompt
            business_hours (str): When to call (e.g. "9:00-18:00 Mon-Fri")
            availability_rules (str): When the team is available for meetings/follow-ups
            language_override (str): Override detected language (2-letter code)

    Returns:
        dict with saved config
    """
    try:
        config = json.loads(config_json)
        voice_config = pipeline_state["preferences"].get("voice_config", {})
        voice_config.update(config)
        pipeline_state["preferences"]["voice_config"] = voice_config

        # Also update top-level preferences for backward compat
        for key in ["caller_name", "call_style", "objective", "pricing_override"]:
            if key in config:
                pipeline_state["preferences"][key] = config[key]

        # Persist
        cid = _campaign_id()
        if cid:
            save_prefs_db(cid, pipeline_state["preferences"])

        return {
            "status": "success",
            "voice_config": voice_config,
            "message": "Voice agent configuration saved. Use this when creating ElevenLabs agents.",
        }
    except json.JSONDecodeError as e:
        return {"status": "error", "error": f"Invalid JSON: {e}"}


@traced(type="tool", name="get_voice_agent_config")
def get_voice_agent_config() -> dict:
    """Gets the current voice agent configuration and all data needed to create agents.

    Returns a complete view of: voice config, business info summary, ready leads
    with their pitches, and any existing agents.
    """
    analysis = pipeline_state.get("business_analysis", {}) or {}
    judged = pipeline_state.get("judged_pitches", [])
    prefs = pipeline_state.get("preferences", {})
    voice_config = prefs.get("voice_config", {})
    agents = pipeline_state.get("elevenlabs_agents", [])

    # Fallback: if no judged pitches, use raw pitches + scored_leads for phone numbers
    if not judged:
        raw_pitches = pipeline_state.get("pitches", [])
        scored_leads = pipeline_state.get("scored_leads", [])
        if raw_pitches:
            phone_lookup = {}
            for lead in scored_leads:
                name = lead.get("lead_name") or lead.get("name", "")
                phone = lead.get("phone_number") or lead.get("phone", "")
                if name and phone:
                    phone_lookup[name] = phone
            for p in raw_pitches:
                lead_name = p.get("lead_name", "")
                phone = p.get("phone_number") or phone_lookup.get(lead_name, "")
                if phone:
                    p["phone_number"] = phone
                    p["ready_to_call"] = True
                    p["score"] = p.get("score", 7)
            judged = raw_pitches
            pipeline_state["judged_pitches"] = judged

    ready_leads_detail = []
    for p in judged:
        is_ready = p.get("ready_to_call") or p.get("readytocall") or p.get("readyToCall") or (p.get("score", 0) >= 7 and p.get("phone_number"))
        # Also consider leads with phone numbers as ready (for testing)
        if not is_ready and p.get("phone_number"):
            is_ready = True
        if is_ready:
            # Find matching pitch script
            pitch_script = p.get("revised_pitch") or p.get("pitch_script") or p.get("pitch", "")
            ready_leads_detail.append({
                "lead_name": p.get("lead_name"),
                "contact_person": p.get("contact_person"),
                "phone_number": p.get("phone_number"),
                "score": p.get("score"),
                "pitch_script": pitch_script[:200] + "..." if len(pitch_script) > 200 else pitch_script,
                "language": p.get("language"),
                "feedback": p.get("feedback", "")[:100],
            })

    return {
        "status": "success",
        "voice_config": voice_config,
        "business_summary": {
            "name": analysis.get("business_name", ""),
            "services": analysis.get("services", []),
            "pricing": analysis.get("pricing_info", "Not found"),
            "language": analysis.get("language", ""),
            "language_code": analysis.get("language_code", ""),
            "differentiators": analysis.get("key_differentiators", []),
        },
        "ready_leads": ready_leads_detail,
        "existing_agents": [
            {"agent_id": a.get("agent_id"), "name": a.get("name"), "language": a.get("language")}
            for a in agents
        ],
        "caller_name": voice_config.get("caller_name") or prefs.get("caller_name", ""),
        "call_style": voice_config.get("call_style") or prefs.get("call_style", "professional"),
        "objective": voice_config.get("objective") or prefs.get("objective", ""),
    }


# ═══════════════════════════════════════════════════════════════════════════════
# 7. EMAIL OUTREACH TOOLS — Resend integration
# ═══════════════════════════════════════════════════════════════════════════════

@traced(type="tool", name="send_email")
def send_email(
    to_email: str,
    from_email: str,
    subject: str,
    body_html: str,
    lead_name: str = "",
    campaign_id_override: int = 0,
) -> dict:
    """Sends a personalized outreach email via Resend API.

    IMPORTANT: The from_email domain must be verified in Resend AND
    the user must have verified domain ownership in LeadCall.

    Args:
        to_email: Recipient email address
        from_email: Sender email (must be from a verified domain)
        subject: Email subject line
        body_html: HTML email body
        lead_name: Name of the lead (for tracking)
        campaign_id_override: Override campaign ID (0 = use current)

    Returns:
        dict with status and email delivery ID
    """
    resend_key = os.getenv("RESEND_API_KEY", "")

    cid = campaign_id_override or _campaign_id()

    if not resend_key:
        # Mock mode
        from db import save_email_outreach
        email_id = save_email_outreach(cid, {
            "to_email": to_email,
            "from_email": from_email,
            "subject": subject,
            "body_html": body_html,
            "status": "mock_sent",
        })
        return {
            "status": "success",
            "mode": "mock",
            "email_id": email_id,
            "message": f"Mock email sent to {to_email}",
        }

    try:
        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {resend_key}",
                "Content-Type": "application/json",
            },
            json={
                "from": from_email,
                "to": [to_email],
                "subject": subject,
                "html": body_html,
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        resend_id = data.get("id", "")

        from db import save_email_outreach, update_email_status
        email_id = save_email_outreach(cid, {
            "to_email": to_email,
            "from_email": from_email,
            "subject": subject,
            "body_html": body_html,
            "status": "sent",
        })
        if resend_id:
            update_email_status(email_id, "sent", resend_id)

        return {
            "status": "success",
            "email_id": email_id,
            "resend_id": resend_id,
            "message": f"Email sent to {to_email}",
        }
    except Exception as e:
        logger.error("Email send error: %s", e)
        return {"status": "error", "error": "Failed to send email. Check configuration."}
