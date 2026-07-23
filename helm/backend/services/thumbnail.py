"""
Thumbnail generation for uploaded photos.
Creates WebP thumbnails at a target width for fast loading in cards/feeds.
"""

import logging
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)

THUMB_WIDTH = 400
THUMB_QUALITY = 80


def generate_thumbnail(source_path: Path, thumb_dir: Path | None = None) -> Path | None:
    """Generate a WebP thumbnail for the given image file.

    Thumbnail is saved alongside the original (or in thumb_dir if provided)
    as ``{stem}_thumb.webp``.  Returns the thumbnail path, or None on failure.
    """
    try:
        out_dir = thumb_dir or source_path.parent
        thumb_path = out_dir / f"{source_path.stem}_thumb.webp"

        with Image.open(source_path) as img:
            img = img.convert("RGB")
            # Maintain aspect ratio
            ratio = THUMB_WIDTH / img.width
            if ratio < 1:
                new_size = (THUMB_WIDTH, int(img.height * ratio))
                img = img.resize(new_size, Image.LANCZOS)
            img.save(thumb_path, "WEBP", quality=THUMB_QUALITY)

        return thumb_path
    except Exception:
        logger.exception("Failed to generate thumbnail for %s", source_path)
        return None


def get_thumbnail_path(source_path: Path) -> Path:
    """Return the expected thumbnail path for a given source image."""
    return source_path.parent / f"{source_path.stem}_thumb.webp"


def ensure_thumbnail(source_path: Path) -> Path:
    """Return thumbnail path, generating it if missing."""
    thumb = get_thumbnail_path(source_path)
    if not thumb.exists() and source_path.exists():
        result = generate_thumbnail(source_path)
        if result:
            return result
    return thumb
