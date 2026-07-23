"""Helpers for inspecting/flattening google.genai-style `contents`."""

import logging

logger = logging.getLogger(__name__)


def flatten_contents(contents) -> str:
    """Convert contents (str or list of Parts) to plain text, dropping image parts."""
    if isinstance(contents, str):
        return contents
    if isinstance(contents, list):
        parts = []
        for item in contents:
            if isinstance(item, str):
                parts.append(item)
            elif hasattr(item, "text"):
                parts.append(item.text)
            elif hasattr(item, "inline_data"):
                logger.debug("Image part reached flatten_contents — dropped (extracted separately)")
        return "\n".join(parts)
    return str(contents)


def contents_has_image(contents) -> bool:
    """True if contents includes an image part (Part.from_bytes → has inline_data)."""
    if isinstance(contents, list):
        return any(hasattr(item, "inline_data") for item in contents)
    return False
