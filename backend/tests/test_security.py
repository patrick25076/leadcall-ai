"""Tests for security module — SSRF prevention, phone validation, rate limiting."""

import pytest
from security import is_safe_url, validate_phone_number, sanitize_url, sanitize_chat_message, RateLimiter


class TestSSRFPrevention:
    """URL validation must block all internal/dangerous URLs."""

    def test_allows_normal_https(self):
        assert is_safe_url("https://example.com") is True
        assert is_safe_url("https://google.com/search?q=test") is True

    def test_allows_normal_http(self):
        assert is_safe_url("http://example.com") is True

    def test_blocks_localhost(self):
        assert is_safe_url("http://localhost") is False
        assert is_safe_url("http://localhost:8080") is False
        assert is_safe_url("https://localhost/admin") is False

    def test_blocks_private_ips(self):
        assert is_safe_url("http://127.0.0.1") is False
        assert is_safe_url("http://10.0.0.1") is False
        assert is_safe_url("http://192.168.1.1") is False
        assert is_safe_url("http://172.16.0.1") is False

    def test_blocks_cloud_metadata(self):
        assert is_safe_url("http://169.254.169.254") is False
        assert is_safe_url("http://169.254.169.254/latest/meta-data/") is False
        assert is_safe_url("http://metadata.google.internal") is False

    def test_blocks_file_protocol(self):
        assert is_safe_url("file:///etc/passwd") is False

    def test_blocks_ftp(self):
        assert is_safe_url("ftp://example.com") is False

    def test_blocks_empty_and_invalid(self):
        assert is_safe_url("") is False
        assert is_safe_url("not-a-url") is False

    def test_blocks_internal_tlds(self):
        assert is_safe_url("http://service.local") is False
        assert is_safe_url("http://app.internal") is False
        assert is_safe_url("http://kubernetes.default.svc") is False


class TestPhoneValidation:
    """Phone numbers must be E.164 format and not emergency/premium."""

    def test_valid_e164(self):
        assert validate_phone_number("+441234567890") is True
        assert validate_phone_number("+40712345678") is True
        assert validate_phone_number("+15551234567") is True
        assert validate_phone_number("+4915123456789") is True

    def test_rejects_no_plus(self):
        assert validate_phone_number("441234567890") is False

    def test_rejects_too_short(self):
        assert validate_phone_number("+1234") is False

    def test_rejects_too_long(self):
        assert validate_phone_number("+12345678901234567") is False

    def test_rejects_letters(self):
        assert validate_phone_number("+44abcdefghij") is False

    def test_rejects_emergency(self):
        assert validate_phone_number("+112") is False
        assert validate_phone_number("+911") is False

    def test_rejects_empty(self):
        assert validate_phone_number("") is False
        assert validate_phone_number("   ") is False


class TestSanitizeUrl:
    """URL sanitization must validate and normalize."""

    def test_adds_https(self):
        assert sanitize_url("example.com") == "https://example.com"

    def test_keeps_existing_https(self):
        assert sanitize_url("https://example.com") == "https://example.com"

    def test_blocks_unsafe(self):
        assert sanitize_url("http://localhost") is None
        assert sanitize_url("http://169.254.169.254") is None

    def test_blocks_too_long(self):
        assert sanitize_url("https://example.com/" + "a" * 3000) is None

    def test_blocks_empty(self):
        assert sanitize_url("") is None
        assert sanitize_url("   ") is None


class TestSanitizeChatMessage:
    """Chat messages must be trimmed and limited."""

    def test_normal_message(self):
        assert sanitize_chat_message("hello") == "hello"

    def test_trims_whitespace(self):
        assert sanitize_chat_message("  hello  ") == "hello"

    def test_rejects_empty(self):
        assert sanitize_chat_message("") is None
        assert sanitize_chat_message("   ") is None

    def test_truncates_long_message(self):
        long_msg = "a" * 20000
        result = sanitize_chat_message(long_msg)
        assert len(result) == 10000


class TestRateLimiter:
    """Rate limiter must track requests per key."""

    def test_allows_within_limit(self):
        limiter = RateLimiter()
        for _ in range(5):
            assert limiter.is_allowed("user1", 5, 60) is True

    def test_blocks_over_limit(self):
        limiter = RateLimiter()
        for _ in range(5):
            limiter.is_allowed("user1", 5, 60)
        assert limiter.is_allowed("user1", 5, 60) is False

    def test_separate_keys(self):
        limiter = RateLimiter()
        for _ in range(5):
            limiter.is_allowed("user1", 5, 60)
        # Different key should still be allowed
        assert limiter.is_allowed("user2", 5, 60) is True
