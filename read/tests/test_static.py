"""Tests for the FastAPI app's static-serving behavior.

The fixture `dist/` has:
    index.html
    posts/welcome-to-read.html
"""

def test_root_serves_index_html(client):
    res = client.get("/")
    assert res.status_code == 200
    assert b"<!doctype html" in res.content.lower()
    assert b"fixture index" in res.content


def test_clean_slug_resolves_to_posts_subdir(client):
    res = client.get("/welcome-to-read")
    assert res.status_code == 200
    assert b"welcome fixture" in res.content


def test_unknown_path_returns_404(client):
    res = client.get("/no-such-thing")
    assert res.status_code == 404


def test_api_routes_not_swallowed_by_static_catchall(client):
    # GET /api/unsubscribe returns 501 from the router, NOT 404 from static
    res = client.get("/api/unsubscribe?token=test")
    assert res.status_code == 501


def test_path_traversal_blocked(client):
    # Even if a file exists outside dist, we must refuse
    res = client.get("/../../../etc/passwd")
    assert res.status_code in (400, 404)


def test_head_root_returns_200(client):
    res = client.head("/")
    assert res.status_code == 200
    # HEAD responses must have no body
    assert res.content == b""


def test_head_clean_slug_returns_200(client):
    res = client.head("/welcome-to-read")
    assert res.status_code == 200
    assert res.content == b""
