import codecs

from samovar_lite.subs import probe_encoding

PERSIAN = "1\n00:00:00,200 --> 00:00:29,000\nسلام دنیا\n"


def test_plain_utf8_is_detected(tmp_path):
    path = tmp_path / "a.srt"
    path.write_text(PERSIAN, encoding="utf-8")
    assert probe_encoding(str(path), "cp1256") == "utf-8"


def test_utf8_bom_is_detected(tmp_path):
    path = tmp_path / "bom.srt"
    path.write_bytes(codecs.BOM_UTF8 + PERSIAN.encode("utf-8"))
    assert probe_encoding(str(path), "cp1256") == "utf-8"


def test_utf16_bom_is_detected(tmp_path):
    # mpv always honours a BOM, so the reported code page does not matter here.
    path = tmp_path / "utf16.srt"
    path.write_bytes(codecs.BOM_UTF16_LE + PERSIAN.encode("utf-16-le"))
    assert probe_encoding(str(path), "cp1256") == "utf-8"


def test_non_utf8_falls_back_to_the_configured_codepage(tmp_path):
    path = tmp_path / "legacy.srt"
    path.write_bytes(PERSIAN.encode("cp1256"))
    assert probe_encoding(str(path), "cp1256") == "cp1256"
    assert probe_encoding(str(path), "gb18030") == "gb18030"


def test_empty_file_counts_as_utf8(tmp_path):
    path = tmp_path / "empty.srt"
    path.write_bytes(b"")
    assert probe_encoding(str(path), "cp1256") == "utf-8"


def test_missing_file_is_not_probed(tmp_path):
    assert probe_encoding(str(tmp_path / "nope.srt"), "cp1256") is None


def test_image_subtitles_are_not_probed(tmp_path):
    path = tmp_path / "bitmap.sup"
    path.write_bytes(b"\xff\x00\xfa\x13 binary" * 10)
    assert probe_encoding(str(path), "cp1256") is None
