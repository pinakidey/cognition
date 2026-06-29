"""Tests for github_client.py — GitHub API interactions."""
import httpx
import pytest
import respx

from github_client import (
    comment_on_issue,
    get_issue,
    get_issue_linked_prs,
    is_issue_open,
    parse_issue_url,
)


# --- parse_issue_url tests ---

def test_parse_valid_url():
    """Parses standard GitHub issue URL."""
    result = parse_issue_url("https://github.com/pinakidey/superset/issues/42")
    assert result == ("pinakidey/superset", 42)


def test_parse_url_with_trailing_content():
    """Parses URL even with extra content after."""
    result = parse_issue_url("https://github.com/owner/repo/issues/1#comment")
    assert result == ("owner/repo", 1)


def test_parse_invalid_url():
    """Returns None for non-GitHub URLs."""
    assert parse_issue_url("https://gitlab.com/owner/repo/issues/1") is None
    assert parse_issue_url("not a url") is None
    assert parse_issue_url("") is None


def test_parse_pr_url_not_matched():
    """PR URLs don't match (different path segment)."""
    assert parse_issue_url("https://github.com/owner/repo/pull/1") is None


# --- API tests ---

@respx.mock
async def test_get_issue_success(monkeypatch):
    """Fetches issue details from GitHub API."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.get("https://api.github.com/repos/owner/repo/issues/1").mock(
        return_value=httpx.Response(200, json={
            "title": "Test Issue",
            "body": "Description",
            "state": "open",
        })
    )

    issue = await get_issue("owner/repo", 1)
    assert issue is not None
    assert issue["title"] == "Test Issue"


@respx.mock
async def test_get_issue_not_found(monkeypatch):
    """Returns None for 404 responses."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.get("https://api.github.com/repos/owner/repo/issues/999").mock(
        return_value=httpx.Response(404, json={"message": "Not Found"})
    )

    issue = await get_issue("owner/repo", 999)
    assert issue is None


@respx.mock
async def test_is_issue_open_true(monkeypatch):
    """Returns True for open issues."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.get("https://api.github.com/repos/owner/repo/issues/1").mock(
        return_value=httpx.Response(200, json={"state": "open"})
    )

    assert await is_issue_open("owner/repo", 1) is True


@respx.mock
async def test_is_issue_open_false(monkeypatch):
    """Returns False for closed issues."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.get("https://api.github.com/repos/owner/repo/issues/2").mock(
        return_value=httpx.Response(200, json={"state": "closed"})
    )

    assert await is_issue_open("owner/repo", 2) is False


@respx.mock
async def test_get_issue_linked_prs(monkeypatch):
    """Returns list of PRs referencing the issue."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.get("https://api.github.com/search/issues").mock(
        return_value=httpx.Response(200, json={
            "items": [
                {"html_url": "https://github.com/owner/repo/pull/10"},
            ]
        })
    )

    prs = await get_issue_linked_prs("owner/repo", 5)
    assert len(prs) == 1
    assert prs[0]["html_url"] == "https://github.com/owner/repo/pull/10"


@respx.mock
async def test_get_issue_linked_prs_none(monkeypatch):
    """Returns empty list when no PRs found."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.get("https://api.github.com/search/issues").mock(
        return_value=httpx.Response(200, json={"items": []})
    )

    prs = await get_issue_linked_prs("owner/repo", 5)
    assert prs == []


@respx.mock
async def test_comment_on_issue_success(monkeypatch):
    """Posts a comment on a GitHub issue."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.post("https://api.github.com/repos/owner/repo/issues/1/comments").mock(
        return_value=httpx.Response(201, json={"id": 123})
    )

    result = await comment_on_issue("owner/repo", 1, "Test comment")
    assert result is True


@respx.mock
async def test_comment_on_issue_failure(monkeypatch):
    """Returns False when comment fails."""
    monkeypatch.setattr("config.settings.gh_token", "ghp_test")
    respx.post("https://api.github.com/repos/owner/repo/issues/1/comments").mock(
        return_value=httpx.Response(403, json={"message": "Forbidden"})
    )

    result = await comment_on_issue("owner/repo", 1, "Test comment")
    assert result is False
