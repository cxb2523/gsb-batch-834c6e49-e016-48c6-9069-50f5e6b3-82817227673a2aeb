"""Subtitle encoding detection shared by manual loads and mpv's auto-discovery.

The rule is the same everywhere: a file that is valid UTF-8 (or carries a BOM) is decoded as
UTF-8; anything else falls back to the code page chosen in the settings. mpv applies the same
rule on its own for a plain ``sub-codepage`` value, so auto-discovered subtitles (``sub-auto``)
and files loaded through this module behave identically.
"""

from __future__ import annotations

import codecs
import os

# Text subtitles larger than this are unheard of; image subtitles (.sup) can be huge, so
# probing is capped instead of reading the whole file into memory.
PROBE_LIMIT = 4 * 1024 * 1024
BINARY_EXT = {".sup", ".idx"}  # image subtitles: no text encoding is involved
_BOMS = (codecs.BOM_UTF8, codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE, codecs.BOM_UTF32_LE, codecs.BOM_UTF32_BE)


def probe_encoding(path: str, fallback: str):
    """Return the code page mpv should use for `path`.

    "utf-8" when the file is valid UTF-8 or starts with a BOM (mpv always honours a BOM),
    otherwise `fallback`. Returns None when probing is pointless (image subtitles) or the
    file cannot be read, meaning the caller should leave the engine's code page alone.
    """
    if os.path.splitext(path)[1].lower() in BINARY_EXT:
        return None
    try:
        with open(path, "rb") as fh:
            data = fh.read(PROBE_LIMIT)
    except OSError:
        return None
    if data.startswith(_BOMS):
        return "utf-8"
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return fallback
    return "utf-8"
