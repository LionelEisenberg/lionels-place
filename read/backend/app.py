"""FastAPI app for read.lionel.place.

Responsibilities:
- Ensure data dir + DB schema exist on startup
- Mount /api/* routes (subscribe + unsubscribe stub)
- Serve the static built dist/ tree with clean-slug URLs
"""
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response

from .database import engine
from .models import Base
from .routes import router


# --- Startup -----------------------------------------------------------

_data_dir = os.environ.get("READ_DATA_DIR", "/app/data")
os.makedirs(_data_dir, exist_ok=True)
Base.metadata.create_all(bind=engine)

DIST_DIR = Path(os.environ.get("READ_DIST_DIR", "/app/dist")).resolve()


# --- App ---------------------------------------------------------------

app = FastAPI(title="read.lionel.place")
app.include_router(router)  # MUST be registered before the catch-all below


@app.api_route("/", methods=["GET", "HEAD"])
def _serve_index():
    index = DIST_DIR / "index.html"
    if not index.is_file():
        raise HTTPException(status_code=404)
    return FileResponse(index)


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def _serve_static(path: str):
    """Mimic nginx `try_files $uri $uri/ $uri.html /posts/$uri.html =404`.

    Refuses any candidate whose resolved real path escapes DIST_DIR.
    """
    candidates = (
        DIST_DIR / path,
        DIST_DIR / path / "index.html",
        DIST_DIR / f"{path}.html",
        DIST_DIR / "posts" / f"{path}.html",
    )
    for cand in candidates:
        if not cand.is_file():
            continue
        # Path traversal guard
        try:
            real = cand.resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if not real.is_relative_to(DIST_DIR):
            continue
        return FileResponse(real)
    return Response(status_code=404)
