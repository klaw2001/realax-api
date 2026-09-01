#!/usr/bin/env python3
"""Extract dot-leader blanks from a flattened OREA form PDF.

The OREA forms are print output: they carry no AcroForm fields, so every
blank a human would write into is just a run of '.' characters sitting in
the text layer. This walks that text layer, finds those runs, and emits one
record per blank with the coordinates the fill engine needs to draw over it.

Output is a *raw* extraction — every run the geometry finds, unnamed. A human
curates it afterwards by giving each blank a field name; that curated file is
what gets seeded into FormTemplate. Nothing here guesses at meaning.

Usage
-----
    python3 tools/extract_template.py forms/sources/<file>.pdf 100
    python3 tools/extract_template.py <pdf> <form> --stdout
    python3 tools/extract_template.py <pdf> <form> -o some/other/path.json

Writes forms/templates/<form>.raw.json unless --stdout or -o says otherwise.

Why no dependencies
-------------------
This deliberately uses only the standard library. The forms are RC4-encrypted
(empty user password, the usual "printing allowed, copying denied" setup), use
cross-reference streams and object streams, and Flate-compress everything --
all of which is implemented below. Requiring pdfplumber or PyMuPDF for a tool
that runs a handful of times per OREA revision was not worth the install.

Coordinates
-----------
All coordinates are PDF user space for the page: origin **bottom-left**, units
in points (1/72"). That is the same space `pdf-lib` draws in, so the fill
engine can use these numbers directly with no flipping. Each record also
carries `baseline`, the y of the text baseline the dots sit on, which is what
you actually want to draw a value at -- `bbox[1]` is the bottom of the glyph
box and sits slightly lower.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zlib
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------
# Tuning
# --------------------------------------------------------------------------

# A blank has to be at least this many leader characters. Below this we are
# looking at an ellipsis in body text ("...") or a decimal point, not a blank.
MIN_RUN = 4

# Characters that can form a leader run. OREA uses '.' throughout; underscores
# are here because a couple of the schedules switch to them mid-form.
LEADER_CHARS = ".․·_"

# Two glyphs belong to the same text line if their baselines differ by less
# than this many points. Generous enough for the slight baseline drift in
# flattened output, tight enough not to merge adjacent form rows.
LINE_TOL = 2.0

# Leader dots repeat at a fixed pitch (2.2-2.5pt across all four forms). An
# advance wider than this multiple of the run's own median pitch means the
# leader stopped and a new one started, so the run breaks there. Measured
# against the run's own pitch rather than the font size because that is
# self-calibrating: the observed pitches are tightly clustered at ~2.5pt and
# the next distinct advance is ~7pt, so anything in between is unambiguous.
#
# This is what keeps a blank from spanning the two-column divide on the
# signature pages, where a left-column field and a right-column field sit on
# one baseline with no text between them.
RUN_BREAK_FACTOR = 2.5


# --------------------------------------------------------------------------
# PDF object model
# --------------------------------------------------------------------------


class Name(str):
    """A PDF name (/Foo). Subclasses str so it compares cleanly."""

    __slots__ = ()


class Ref:
    """An indirect reference (`12 0 R`)."""

    __slots__ = ("num", "gen")

    def __init__(self, num: int, gen: int):
        self.num = num
        self.gen = gen

    def __repr__(self) -> str:
        return f"Ref({self.num},{self.gen})"

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Ref) and (self.num, self.gen) == (other.num, other.gen)

    def __hash__(self) -> int:
        return hash((self.num, self.gen))


class Stream:
    __slots__ = ("dict", "raw", "doc", "_data")

    def __init__(self, d: dict, raw: bytes, doc: "PdfDocument | None" = None):
        self.dict = d
        self.raw = raw
        self.doc = doc
        self._data: bytes | None = None

    def data(self) -> bytes:
        """Decoded stream contents, applying the /Filter chain."""
        if self._data is not None:
            return self._data
        out = self.raw
        filters = self.doc.resolve(self.dict.get("Filter")) if self.doc else self.dict.get("Filter")
        if filters is None:
            filters = []
        elif isinstance(filters, Name):
            filters = [filters]
        parms = self.doc.resolve(self.dict.get("DecodeParms")) if self.doc else self.dict.get("DecodeParms")
        if parms is None or isinstance(parms, dict):
            parms = [parms] * len(filters)
        for f, pm in zip(filters, parms):
            f = self.doc.resolve(f) if self.doc else f
            pm = (self.doc.resolve(pm) if self.doc else pm) or {}
            if f in ("FlateDecode", "Fl"):
                out = _flate(out)
                out = _predictor(out, pm, self.doc)
            elif f in ("ASCIIHexDecode", "AHx"):
                out = _ascii_hex(out)
            elif f in ("ASCII85Decode", "A85"):
                out = _ascii85(out)
            elif f in ("LZWDecode", "LZW"):
                out = _lzw(out)
                out = _predictor(out, pm, self.doc)
            elif f in ("RunLengthDecode", "RL"):
                out = _runlength(out)
            else:
                # An image filter (DCT/JPX/CCITT). We never read image bytes,
                # so stop here rather than pretending we decoded it.
                break
        self._data = out
        return out


def _flate(b: bytes) -> bytes:
    try:
        return zlib.decompress(b)
    except zlib.error:
        # Truncated or slightly malformed stream -- salvage what inflates.
        d = zlib.decompressobj()
        try:
            return d.decompress(b)
        except zlib.error:
            for skip in range(1, 3):
                try:
                    return zlib.decompressobj().decompress(b[skip:])
                except zlib.error:
                    continue
            return b""


def _predictor(data: bytes, parms: dict, doc: "PdfDocument | None") -> bytes:
    def g(k, default):
        v = parms.get(k, default)
        return doc.resolve(v) if doc else v

    pred = g("Predictor", 1)
    if not pred or pred < 2:
        return data
    colors = g("Colors", 1)
    bpc = g("BitsPerComponent", 8)
    columns = g("Columns", 1)
    bpp = max(1, (colors * bpc + 7) // 8)
    rowlen = (columns * colors * bpc + 7) // 8
    if pred == 2:
        return data  # TIFF predictor; not used by anything we read.
    out = bytearray()
    prev = bytearray(rowlen)
    pos = 0
    while pos + 1 <= len(data) - 1:
        ft = data[pos]
        pos += 1
        row = bytearray(data[pos : pos + rowlen])
        if len(row) < rowlen:
            row.extend(b"\x00" * (rowlen - len(row)))
        pos += rowlen
        if ft == 1:
            for i in range(bpp, rowlen):
                row[i] = (row[i] + row[i - bpp]) & 0xFF
        elif ft == 2:
            for i in range(rowlen):
                row[i] = (row[i] + prev[i]) & 0xFF
        elif ft == 3:
            for i in range(rowlen):
                left = row[i - bpp] if i >= bpp else 0
                row[i] = (row[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ft == 4:
            for i in range(rowlen):
                a = row[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                row[i] = (row[i] + pr) & 0xFF
        out.extend(row)
        prev = row
    return bytes(out)


def _ascii_hex(b: bytes) -> bytes:
    b = b.split(b">")[0]
    h = re.sub(rb"[^0-9A-Fa-f]", b"", b)
    if len(h) % 2:
        h += b"0"
    return bytes.fromhex(h.decode("ascii"))


def _ascii85(b: bytes) -> bytes:
    b = re.sub(rb"\s", b"", b)
    if b.startswith(b"<~"):
        b = b[2:]
    b = b.split(b"~>")[0]
    out = bytearray()
    i = 0
    while i < len(b):
        if b[i : i + 1] == b"z":
            out += b"\x00\x00\x00\x00"
            i += 1
            continue
        chunk = b[i : i + 5]
        i += 5
        pad = 5 - len(chunk)
        chunk = chunk + b"u" * pad
        n = 0
        for c in chunk:
            n = n * 85 + (c - 33)
        four = n.to_bytes(4, "big")
        out += four[: 4 - pad]
    return bytes(out)


def _runlength(b: bytes) -> bytes:
    out = bytearray()
    i = 0
    while i < len(b):
        l = b[i]
        i += 1
        if l == 128:
            break
        if l < 128:
            out += b[i : i + l + 1]
            i += l + 1
        else:
            out += b[i : i + 1] * (257 - l)
            i += 1
    return bytes(out)


def _lzw(b: bytes) -> bytes:
    out = bytearray()
    table = [bytes([i]) for i in range(256)] + [b"", b""]
    bits, width, prev = 0, 9, None
    acc = 0
    for byte in b:
        acc = (acc << 8) | byte
        bits += 8
        while bits >= width:
            bits -= width
            code = (acc >> bits) & ((1 << width) - 1)
            if code == 256:
                table = [bytes([i]) for i in range(256)] + [b"", b""]
                width, prev = 9, None
                continue
            if code == 257:
                return bytes(out)
            if prev is None:
                entry = table[code]
            elif code < len(table):
                entry = table[code]
                table.append(prev + entry[:1])
            else:
                entry = prev + prev[:1]
                table.append(entry)
            out += entry
            prev = entry
            if len(table) + 1 >= (1 << width) and width < 12:
                width += 1
    return bytes(out)


# --------------------------------------------------------------------------
# Tokenizer / object parser
# --------------------------------------------------------------------------

WHITESPACE = b"\x00\t\n\x0c\r "
DELIMS = b"()<>[]{}/%"


class Lexer:
    def __init__(self, data: bytes, pos: int = 0):
        self.data = data
        self.pos = pos

    def skip_ws(self) -> None:
        d, n = self.data, len(self.data)
        while self.pos < n:
            c = d[self.pos]
            if c in WHITESPACE:
                self.pos += 1
            elif c == 0x25:  # '%' comment
                while self.pos < n and d[self.pos] not in b"\r\n":
                    self.pos += 1
            else:
                return

    def read_token(self) -> bytes | None:
        self.skip_ws()
        d, n = self.data, len(self.data)
        if self.pos >= n:
            return None
        c = d[self.pos]
        if c in b"[]{}":
            self.pos += 1
            return bytes([c])
        if c == 0x3C:  # '<'
            if self.pos + 1 < n and d[self.pos + 1] == 0x3C:
                self.pos += 2
                return b"<<"
            return self._hex_string()
        if c == 0x3E:  # '>'
            if self.pos + 1 < n and d[self.pos + 1] == 0x3E:
                self.pos += 2
                return b">>"
            self.pos += 1
            return b">"
        if c == 0x28:  # '('
            return self._literal_string()
        if c == 0x2F:  # '/'
            return self._name()
        start = self.pos
        while self.pos < n and d[self.pos] not in WHITESPACE and d[self.pos] not in DELIMS:
            self.pos += 1
        if self.pos == start:
            self.pos += 1
        return d[start : self.pos]

    def _name(self) -> bytes:
        d, n = self.data, len(self.data)
        self.pos += 1
        start = self.pos
        while self.pos < n and d[self.pos] not in WHITESPACE and d[self.pos] not in DELIMS:
            self.pos += 1
        return b"/" + d[start : self.pos]

    def _hex_string(self) -> bytes:
        d, n = self.data, len(self.data)
        self.pos += 1
        start = self.pos
        while self.pos < n and d[self.pos] != 0x3E:
            self.pos += 1
        raw = d[start : self.pos]
        self.pos += 1
        return b"\x00HEX" + raw

    def _literal_string(self) -> bytes:
        d, n = self.data, len(self.data)
        self.pos += 1
        depth = 1
        out = bytearray()
        while self.pos < n:
            c = d[self.pos]
            if c == 0x5C:  # backslash
                self.pos += 1
                if self.pos >= n:
                    break
                e = d[self.pos]
                mapping = {0x6E: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12}
                if e in mapping:
                    out.append(mapping[e])
                    self.pos += 1
                elif 0x30 <= e <= 0x37:  # octal
                    oct_digits = ""
                    for _ in range(3):
                        if self.pos < n and 0x30 <= d[self.pos] <= 0x37:
                            oct_digits += chr(d[self.pos])
                            self.pos += 1
                        else:
                            break
                    out.append(int(oct_digits, 8) & 0xFF)
                elif e in b"\r\n":  # line continuation
                    self.pos += 1
                    if e == 13 and self.pos < n and d[self.pos] == 10:
                        self.pos += 1
                else:
                    out.append(e)
                    self.pos += 1
                continue
            if c == 0x28:
                depth += 1
            elif c == 0x29:
                depth -= 1
                if depth == 0:
                    self.pos += 1
                    break
            out.append(c)
            self.pos += 1
        return b"\x00LIT" + bytes(out)


NUM_RE = re.compile(rb"^[+-]?(\d+\.?\d*|\.\d+)$")


class Parser:
    """Builds Python objects out of the token stream."""

    def __init__(self, data: bytes, pos: int = 0, doc: "PdfDocument | None" = None):
        self.lex = Lexer(data, pos)
        self.doc = doc

    @property
    def pos(self) -> int:
        return self.lex.pos

    def parse(self) -> Any:
        tok = self.lex.read_token()
        return self._from_token(tok)

    def _from_token(self, tok: bytes | None) -> Any:
        if tok is None:
            return None
        if tok == b"<<":
            return self._dict()
        if tok == b"[":
            return self._array()
        if tok.startswith(b"\x00LIT"):
            return tok[4:]
        if tok.startswith(b"\x00HEX"):
            h = re.sub(rb"[^0-9A-Fa-f]", b"", tok[4:])
            if len(h) % 2:
                h += b"0"
            return bytes.fromhex(h.decode("ascii"))
        if tok.startswith(b"/"):
            return Name(_decode_name(tok[1:]))
        if tok == b"true":
            return True
        if tok == b"false":
            return False
        if tok == b"null":
            return None
        if NUM_RE.match(tok):
            s = tok.decode("ascii")
            return float(s) if ("." in s) else int(s)
        return Keyword(tok)

    def _array(self) -> list:
        items: list = []
        while True:
            save = self.lex.pos
            tok = self.lex.read_token()
            if tok is None or tok == b"]":
                break
            if tok == b"R" and len(items) >= 2 and isinstance(items[-1], int) and isinstance(items[-2], int):
                gen = items.pop()
                num = items.pop()
                items.append(Ref(num, gen))
                continue
            self.lex.pos = save
            items.append(self.parse())
        return items

    def _dict(self) -> Any:
        d: dict = {}
        pending: list = []
        while True:
            tok = self.lex.read_token()
            if tok is None or tok == b">>":
                break
            if tok.startswith(b"/") and not pending:
                key = _decode_name(tok[1:])
                # Parse the value, watching for `n g R`.
                vals: list = []
                while True:
                    save = self.lex.pos
                    t2 = self.lex.read_token()
                    if t2 is None:
                        break
                    if t2 == b"R" and len(vals) >= 2 and isinstance(vals[-1], int) and isinstance(vals[-2], int):
                        gen = vals.pop()
                        num = vals.pop()
                        vals.append(Ref(num, gen))
                        continue
                    if (t2.startswith(b"/") or t2 == b">>") and vals:
                        self.lex.pos = save
                        break
                    self.lex.pos = save
                    v = self.parse()
                    vals.append(v)
                    if not (isinstance(v, int) and len(vals) <= 2):
                        break
                d[key] = vals[0] if vals else None
                continue
        # A stream may follow the dict.
        save = self.lex.pos
        tok = self.lex.read_token()
        if isinstance(tok, bytes) and tok == b"stream":
            data = self.lex.data
            p = self.lex.pos
            if data[p : p + 2] == b"\r\n":
                p += 2
            elif data[p : p + 1] in (b"\n", b"\r"):
                p += 1
            length = d.get("Length")
            if self.doc is not None:
                length = self.doc.resolve(length)
            if not isinstance(length, int) or length < 0 or p + length > len(data):
                end = data.find(b"endstream", p)
                length = (end - p) if end != -1 else (len(data) - p)
            raw = data[p : p + length]
            # Trust `endstream` over a wrong /Length.
            after = data[p + length : p + length + 20]
            if b"endstream" not in after:
                end = data.find(b"endstream", p)
                if end != -1:
                    raw = data[p:end].rstrip(b"\r\n")
                    length = end - p
            self.lex.pos = p + length
            t = self.lex.read_token()
            if t != b"endstream":
                e = data.find(b"endstream", p + length)
                self.lex.pos = (e + 9) if e != -1 else len(data)
            return Stream(d, raw, self.doc)
        self.lex.pos = save
        return d


class Keyword(str):
    __slots__ = ()

    def __new__(cls, b: bytes):
        return super().__new__(cls, b.decode("latin-1"))


def _decode_name(b: bytes) -> str:
    out = bytearray()
    i = 0
    while i < len(b):
        if b[i] == 0x23 and i + 2 < len(b):
            try:
                out.append(int(b[i + 1 : i + 3], 16))
                i += 3
                continue
            except ValueError:
                pass
        out.append(b[i])
        i += 1
    return out.decode("latin-1")


# --------------------------------------------------------------------------
# Encryption (standard security handler, empty user password)
# --------------------------------------------------------------------------

_PAD = bytes(
    [
        0x28, 0xBF, 0x4E, 0x5E, 0x4E, 0x75, 0x8A, 0x41, 0x64, 0x00, 0x4E, 0x56,
        0xFF, 0xFA, 0x01, 0x08, 0x2E, 0x2E, 0x00, 0xB6, 0xD0, 0x68, 0x3E, 0x80,
        0x2F, 0x0C, 0xA9, 0xFE, 0x64, 0x53, 0x69, 0x7A,
    ]
)


def _rc4(key: bytes, data: bytes) -> bytes:
    S = list(range(256))
    j = 0
    klen = len(key)
    for i in range(256):
        j = (j + S[i] + key[i % klen]) & 0xFF
        S[i], S[j] = S[j], S[i]
    out = bytearray(len(data))
    i = j = 0
    for n, c in enumerate(data):
        i = (i + 1) & 0xFF
        j = (j + S[i]) & 0xFF
        S[i], S[j] = S[j], S[i]
        out[n] = c ^ S[(S[i] + S[j]) & 0xFF]
    return bytes(out)


def _aes_cbc_decrypt(key: bytes, data: bytes) -> bytes:
    """Minimal AES-CBC decrypt, for /V 4 or 5 forms (AESV2/AESV3)."""
    if len(data) <= 16:
        return b""
    aes = _AES(key)
    iv, body = data[:16], data[16:]
    out = bytearray()
    prev = iv
    for i in range(0, len(body) - (len(body) % 16), 16):
        blk = body[i : i + 16]
        dec = aes.decrypt_block(blk)
        out += bytes(a ^ b for a, b in zip(dec, prev))
        prev = blk
    if out:
        pad = out[-1]
        if 1 <= pad <= 16:
            out = out[:-pad]
    return bytes(out)


class _AES:
    """Decrypt-only AES. Small, and keeps the tool dependency-free."""

    _sbox = None
    _inv = None
    _rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1B, 0x36, 0x6C, 0xD8, 0xAB, 0x4D]

    @classmethod
    def _tables(cls):
        if cls._sbox is not None:
            return
        p = q = 1
        sbox = [0] * 256
        while True:
            p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)
            q ^= q << 1
            q ^= q << 2
            q ^= q << 4
            q &= 0xFF
            if q & 0x80:
                q ^= 0x09
            x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4))
            sbox[p] = (x ^ 0x63) & 0xFF
            if p == 1:
                break
        sbox[0] = 0x63
        inv = [0] * 256
        for i, v in enumerate(sbox):
            inv[v] = i
        cls._sbox, cls._inv = sbox, inv

    def __init__(self, key: bytes):
        self._tables()
        self.nk = len(key) // 4
        self.nr = self.nk + 6
        self.w = self._expand(key)

    def _expand(self, key: bytes) -> list:
        nk, nr = self.nk, self.nr
        w = [list(key[4 * i : 4 * i + 4]) for i in range(nk)]
        for i in range(nk, 4 * (nr + 1)):
            t = list(w[i - 1])
            if i % nk == 0:
                t = t[1:] + t[:1]
                t = [self._sbox[b] for b in t]
                t[0] ^= self._rcon[i // nk - 1]
            elif nk > 6 and i % nk == 4:
                t = [self._sbox[b] for b in t]
            w.append([a ^ b for a, b in zip(w[i - nk], t)])
        return w

    @staticmethod
    def _xt(a: int, b: int) -> int:
        r = 0
        for _ in range(8):
            if b & 1:
                r ^= a
            hi = a & 0x80
            a = (a << 1) & 0xFF
            if hi:
                a ^= 0x1B
            b >>= 1
        return r

    def decrypt_block(self, blk: bytes) -> bytes:
        s = [list(blk[i::4]) for i in range(4)]

        def addrk(rnd):
            for c in range(4):
                for r in range(4):
                    s[r][c] ^= self.w[rnd * 4 + c][r]

        addrk(self.nr)
        for rnd in range(self.nr - 1, -1, -1):
            for r in range(1, 4):  # inv shift rows
                s[r] = s[r][-r:] + s[r][:-r]
            for r in range(4):  # inv sub bytes
                s[r] = [self._inv[b] for b in s[r]]
            addrk(rnd)
            if rnd:  # inv mix columns
                for c in range(4):
                    a = [s[r][c] for r in range(4)]
                    s[0][c] = self._xt(a[0], 14) ^ self._xt(a[1], 11) ^ self._xt(a[2], 13) ^ self._xt(a[3], 9)
                    s[1][c] = self._xt(a[0], 9) ^ self._xt(a[1], 14) ^ self._xt(a[2], 11) ^ self._xt(a[3], 13)
                    s[2][c] = self._xt(a[0], 13) ^ self._xt(a[1], 9) ^ self._xt(a[2], 14) ^ self._xt(a[3], 11)
                    s[3][c] = self._xt(a[0], 11) ^ self._xt(a[1], 13) ^ self._xt(a[2], 9) ^ self._xt(a[3], 14)
        return bytes(s[r][c] for c in range(4) for r in range(4))


class Decryptor:
    def __init__(self, enc: dict, doc_id: bytes, doc: "PdfDocument"):
        r = doc.resolve
        self.v = r(enc.get("V", 0)) or 0
        self.rev = r(enc.get("R", 2)) or 2
        length = r(enc.get("Length", 40)) or 40
        o = r(enc.get("O")) or b""
        u = r(enc.get("U")) or b""
        p = r(enc.get("P", 0)) or 0
        self.method = "RC4"
        n = length // 8
        if self.v >= 4:
            cf = r(enc.get("CF")) or {}
            stmf = r(enc.get("StmF")) or "Identity"
            f = r(cf.get(stmf)) or {}
            cfm = r(f.get("CFM")) or "V2"
            if cfm == "AESV2":
                self.method, n = "AESV2", 16
            elif cfm == "AESV3":
                self.method, n = "AESV3", 32
            elif cfm == "None" or stmf == "Identity":
                self.method = "Identity"
            if r(f.get("Length")):
                fl = r(f.get("Length"))
                n = fl if fl > 40 else fl  # some writers store bytes, some bits
                n = n // 8 if n > 40 else n
        if self.rev >= 5:
            # AES-256: key comes straight out of a SHA-256 over the U salt.
            self.method = "AESV3"
            self.key = self._r5_key(u, r(enc.get("UE")) or b"")
            return
        self.n = n
        h = hashlib.md5()
        h.update(_PAD)
        h.update(o[:32] if isinstance(o, bytes) else b"")
        h.update((p & 0xFFFFFFFF).to_bytes(4, "little"))
        h.update(doc_id)
        if self.rev >= 4 and r(enc.get("EncryptMetadata", True)) is False:
            h.update(b"\xff\xff\xff\xff")
        key = h.digest()
        if self.rev >= 3:
            for _ in range(50):
                key = hashlib.md5(key[:n]).digest()
        self.key = key[:n]

    @staticmethod
    def _r5_key(u: bytes, ue: bytes) -> bytes:
        vsalt, ksalt = u[32:40], u[40:48]
        del vsalt
        ik = hashlib.sha256(b"" + ksalt).digest()
        aes = _AES(ik)
        out = bytearray()
        prev = b"\x00" * 16
        for i in range(0, len(ue), 16):
            blk = ue[i : i + 16]
            dec = aes.decrypt_block(blk)
            out += bytes(a ^ b for a, b in zip(dec, prev))
            prev = blk
        return bytes(out[:32])

    def decrypt(self, data: bytes, num: int, gen: int) -> bytes:
        if self.method == "Identity":
            return data
        if self.method == "AESV3":
            return _aes_cbc_decrypt(self.key, data)
        k = self.key + num.to_bytes(3, "little") + gen.to_bytes(2, "little")
        if self.method == "AESV2":
            k += b"sAlT"
        ok = hashlib.md5(k).digest()[: min(len(self.key) + 5, 16)]
        if self.method == "AESV2":
            return _aes_cbc_decrypt(ok, data)
        return _rc4(ok, data)


# --------------------------------------------------------------------------
# Document
# --------------------------------------------------------------------------

OBJ_RE = re.compile(rb"(?<![0-9])(\d+)\s+(\d+)\s+obj\b")


class PdfDocument:
    def __init__(self, data: bytes):
        self.data = data
        self.offsets: dict[int, tuple[int, int]] = {}
        self.cache: dict[int, Any] = {}
        self.objstm_index: dict[int, tuple[int, int]] = {}
        self.decryptor: Decryptor | None = None
        self.trailer: dict = {}
        self._scan_objects()
        self._read_trailer()
        self._setup_encryption()
        self._index_object_streams()

    # -- object location ---------------------------------------------------

    def _scan_objects(self) -> None:
        """Index every `N G obj` in the file.

        We scan rather than follow the xref table: it is simpler, and it keeps
        working on the lightly-damaged files that come out of some of the
        board's export tooling.
        """
        for m in OBJ_RE.finditer(self.data):
            num, gen = int(m.group(1)), int(m.group(2))
            self.offsets[num] = (m.end(), gen)  # later definition wins

    def _read_trailer(self) -> None:
        # Classic trailer dictionaries first...
        for m in re.finditer(rb"trailer", self.data):
            p = Parser(self.data, m.end(), self)
            t = p.parse()
            if isinstance(t, dict):
                for k, v in t.items():
                    self.trailer.setdefault(k, v)
        # ...then any cross-reference stream dictionaries, which is what these
        # forms actually use.
        for num, (off, gen) in self.offsets.items():
            head = self.data[off : off + 400]
            if b"/XRef" not in head:
                continue
            obj = self._parse_at(off, num, gen, decrypt=False)
            if isinstance(obj, Stream):
                for k, v in obj.dict.items():
                    self.trailer.setdefault(k, v)

    def _setup_encryption(self) -> None:
        enc = self.trailer.get("Encrypt")
        if enc is None:
            return
        enc_num = enc.num if isinstance(enc, Ref) else None
        enc = self.resolve(enc, decrypt=False)
        if not isinstance(enc, dict):
            return
        ids = self.trailer.get("ID")
        first_id = b""
        if isinstance(ids, list) and ids and isinstance(ids[0], bytes):
            first_id = ids[0]
        self.decryptor = Decryptor(enc, first_id, self)
        self._enc_num = enc_num
        self.cache.clear()

    def _index_object_streams(self) -> None:
        for num, (off, gen) in list(self.offsets.items()):
            head = self.data[off : off + 400]
            if b"/ObjStm" not in head:
                continue
            stm = self.get(num)
            if not isinstance(stm, Stream):
                continue
            n = self.resolve(stm.dict.get("N")) or 0
            first = self.resolve(stm.dict.get("First")) or 0
            body = stm.data()
            lex = Lexer(body, 0)
            pairs = []
            for _ in range(n):
                a = lex.read_token()
                b = lex.read_token()
                if a is None or b is None:
                    break
                try:
                    pairs.append((int(a), int(b)))
                except ValueError:
                    break
            for onum, orel in pairs:
                if onum not in self.offsets:  # a top-level def always wins
                    self.objstm_index[onum] = (num, first + orel)

    # -- resolution --------------------------------------------------------

    def _parse_at(self, off: int, num: int, gen: int, decrypt: bool = True) -> Any:
        p = Parser(self.data, off, self)
        obj = p.parse()
        if decrypt and self.decryptor is not None and num != getattr(self, "_enc_num", None):
            obj = self._decrypt_obj(obj, num, gen)
        return obj

    def _decrypt_obj(self, obj: Any, num: int, gen: int) -> Any:
        d = self.decryptor
        assert d is not None
        if isinstance(obj, Stream):
            if self.resolve(obj.dict.get("Type")) != "XRef":
                obj.raw = d.decrypt(obj.raw, num, gen)
            obj.dict = self._decrypt_obj(obj.dict, num, gen)
            return obj
        if isinstance(obj, bytes):
            return d.decrypt(obj, num, gen)
        if isinstance(obj, list):
            return [self._decrypt_obj(v, num, gen) for v in obj]
        if isinstance(obj, dict):
            return {k: self._decrypt_obj(v, num, gen) for k, v in obj.items()}
        return obj

    def get(self, num: int) -> Any:
        if num in self.cache:
            return self.cache[num]
        self.cache[num] = None  # cycle guard
        obj = None
        if num in self.offsets:
            off, gen = self.offsets[num]
            obj = self._parse_at(off, num, gen)
        elif num in self.objstm_index:
            stm_num, rel = self.objstm_index[num]
            stm = self.get(stm_num)
            if isinstance(stm, Stream):
                body = stm.data()
                if 0 <= rel < len(body):
                    # Objects inside an object stream are already covered by
                    # the stream's own decryption -- do not decrypt twice.
                    obj = Parser(body, rel, self).parse()
        self.cache[num] = obj
        return obj

    def resolve(self, obj: Any, decrypt: bool = True) -> Any:
        seen = 0
        while isinstance(obj, Ref):
            obj = self.get(obj.num)
            seen += 1
            if seen > 64:
                return None
        return obj

    def d(self, container: Any, key: str, default: Any = None) -> Any:
        c = self.resolve(container)
        if isinstance(c, Stream):
            c = c.dict
        if not isinstance(c, dict):
            return default
        v = c.get(key, default)
        return self.resolve(v)

    # -- page tree ---------------------------------------------------------

    def pages(self) -> list[dict]:
        root = self.resolve(self.trailer.get("Root"))
        pages_node = self.d(root, "Pages") if isinstance(root, dict) else None
        out: list[dict] = []
        if pages_node:
            self._walk_pages(pages_node, {}, out, set())
        if not out:
            # No usable /Pages tree -- fall back to every /Type /Page object.
            for num in sorted(set(list(self.offsets) + list(self.objstm_index))):
                o = self.get(num)
                if isinstance(o, dict) and self.resolve(o.get("Type")) == "Page":
                    out.append(o)
        return out

    _INHERIT = ("Resources", "MediaBox", "CropBox", "Rotate")

    def _walk_pages(self, node: Any, inherited: dict, out: list, seen: set) -> None:
        node = self.resolve(node)
        if not isinstance(node, dict):
            return
        nid = id(node)
        if nid in seen:
            return
        seen.add(nid)
        inh = dict(inherited)
        for k in self._INHERIT:
            if k in node:
                inh[k] = node[k]
        kids = self.resolve(node.get("Kids"))
        if self.resolve(node.get("Type")) == "Page" or (kids is None and "Contents" in node):
            merged = dict(inh)
            merged.update(node)
            out.append(merged)
            return
        if isinstance(kids, list):
            for kid in kids:
                self._walk_pages(kid, inh, out, seen)

    def page_content(self, page: dict) -> bytes:
        c = self.resolve(page.get("Contents"))
        parts: list[bytes] = []
        if isinstance(c, Stream):
            parts.append(c.data())
        elif isinstance(c, list):
            for item in c:
                s = self.resolve(item)
                if isinstance(s, Stream):
                    parts.append(s.data())
        return b"\n".join(parts)


# --------------------------------------------------------------------------
# Fonts
# --------------------------------------------------------------------------

# Widths for the base-14 faces, in 1/1000 em, for codes 32..126. Only needed
# when a font dictionary omits /Widths, which the standard fonts are allowed
# to do. Anything outside this range falls back to MissingWidth.
_HELV = (
    "278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 "
    "556 556 278 278 584 584 584 556 1015 667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 "
    "667 778 722 667 611 722 667 944 667 667 611 278 278 278 469 556 333 556 556 500 556 556 278 556 "
    "556 222 222 500 222 833 556 556 556 556 333 500 278 556 500 722 500 500 500 334 260 334 584"
)
_HELV_B = (
    "278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 556 556 556 556 556 556 556 556 "
    "556 556 333 333 584 584 584 611 975 722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 "
    "667 778 722 667 611 722 667 944 667 667 611 333 278 333 584 556 333 556 611 556 611 556 333 611 "
    "611 278 278 556 278 889 611 611 611 611 389 556 333 611 556 778 556 556 500 389 280 389 584"
)
_TIMES = (
    "250 333 408 500 500 833 778 180 333 333 500 564 250 333 250 278 500 500 500 500 500 500 500 500 "
    "500 500 278 278 564 564 564 444 921 722 667 667 722 611 556 722 722 333 389 722 611 889 722 722 "
    "556 722 667 556 611 722 722 944 722 722 611 333 278 333 469 500 333 444 500 444 500 444 333 500 "
    "500 278 278 500 278 778 500 500 500 500 333 389 278 500 500 722 500 500 444 480 200 480 541"
)
_TIMES_B = (
    "250 333 555 500 500 1000 833 278 333 333 500 570 250 333 250 278 500 500 500 500 500 500 500 500 "
    "500 500 333 333 570 570 570 500 930 722 667 722 722 667 611 778 778 389 500 778 667 944 722 778 "
    "611 778 722 556 667 722 722 1000 722 722 667 333 278 333 581 500 333 500 556 444 556 444 333 500 "
    "556 278 333 556 278 833 556 500 556 556 444 389 333 556 500 722 500 500 444 394 220 394 520"
)


def _wtable(s: str) -> dict[int, float]:
    return {32 + i: float(v) for i, v in enumerate(s.split())}


_BASE14: dict[str, dict[int, float]] = {}
for _names, _t in (
    (("Helvetica", "Arial", "Helvetica-Oblique", "Arial-Italic", "ArialMT"), _HELV),
    (("Helvetica-Bold", "Arial-Bold", "Helvetica-BoldOblique", "Arial-BoldMT"), _HELV_B),
    (("Times-Roman", "Times", "TimesNewRoman", "Times-Italic", "TimesNewRomanPSMT"), _TIMES),
    (("Times-Bold", "Times-BoldItalic", "TimesNewRomanPS-BoldMT"), _TIMES_B),
):
    for _n in _names:
        _BASE14[_n] = _wtable(_t)

_WIN_ANSI_HIGH = {
    128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†",
    135: "‡", 136: "ˆ", 137: "‰", 138: "Š", 139: "‹", 140: "Œ",
    142: "Ž", 145: "‘", 146: "’", 147: "“", 148: "”", 149: "•",
    150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›",
    156: "œ", 158: "ž", 159: "Ÿ",
}

# Glyph names that actually turn up in /Differences on these forms.
_GLYPH = {
    "space": " ", "period": ".", "comma": ",", "colon": ":", "semicolon": ";", "hyphen": "-",
    "endash": "–", "emdash": "—", "quoteright": "’", "quoteleft": "‘",
    "quotedblleft": "“", "quotedblright": "”", "quotesingle": "'", "quotedbl": '"',
    "parenleft": "(", "parenright": ")", "bracketleft": "[", "bracketright": "]", "slash": "/",
    "backslash": "\\", "underscore": "_", "percent": "%", "dollar": "$", "cent": "¢",
    "ampersand": "&", "asterisk": "*", "plus": "+", "equal": "=", "question": "?", "at": "@",
    "numbersign": "#", "exclam": "!", "bullet": "•", "periodcentered": "·",
    "degree": "°", "section": "§", "paragraph": "¶", "sterling": "£",
    "less": "<", "greater": ">", "bar": "|", "grave": "`", "asciitilde": "~",
}
for _i in range(10):
    _GLYPH[["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"][_i]] = str(_i)


class Font:
    """Everything the interpreter needs: code -> width, and code -> text."""

    def __init__(self, doc: PdfDocument, fd: Any):
        self.doc = doc
        self.dict = doc.resolve(fd) or {}
        if isinstance(self.dict, Stream):
            self.dict = self.dict.dict
        self.subtype = doc.d(self.dict, "Subtype") or ""
        self.base = str(doc.d(self.dict, "BaseFont") or "")
        self.two_byte = self.subtype == "Type0"
        self.widths: dict[int, float] = {}
        self.default_width = 0.0
        self.to_unicode: dict[int, str] = {}
        self.diff: dict[int, str] = {}
        self.base_encoding = ""
        self._load()

    # -- setup -------------------------------------------------------------

    def _load(self) -> None:
        doc = self.doc
        self._load_encoding()
        self._load_tounicode()
        if self.subtype == "Type0":
            self._load_cid_widths()
            return
        first = doc.d(self.dict, "FirstChar")
        widths = doc.d(self.dict, "Widths")
        if isinstance(widths, list) and isinstance(first, int):
            for i, w in enumerate(widths):
                w = doc.resolve(w)
                if isinstance(w, (int, float)):
                    self.widths[first + i] = float(w)
        desc = doc.d(self.dict, "FontDescriptor")
        mw = doc.d(desc, "MissingWidth") if isinstance(desc, dict) else None
        self.default_width = float(mw) if isinstance(mw, (int, float)) else 0.0
        if not self.widths:
            self.widths = dict(self._base14_table())
            if not self.default_width:
                self.default_width = 500.0

    def _base14_table(self) -> dict[int, float]:
        name = self.base.split("+")[-1]
        if name in _BASE14:
            return _BASE14[name]
        low = name.lower()
        bold = "bold" in low
        if "courier" in low or "mono" in low:
            return {c: 600.0 for c in range(32, 127)}
        if "times" in low or "serif" in low or "roman" in low or "georgia" in low:
            return _BASE14["Times-Bold"] if bold else _BASE14["Times-Roman"]
        return _BASE14["Helvetica-Bold"] if bold else _BASE14["Helvetica"]

    def _load_encoding(self) -> None:
        enc = self.doc.d(self.dict, "Encoding")
        if isinstance(enc, Name) or isinstance(enc, str) and not isinstance(enc, dict):
            self.base_encoding = str(enc)
            return
        if isinstance(enc, dict):
            be = self.doc.resolve(enc.get("BaseEncoding"))
            if be:
                self.base_encoding = str(be)
            diffs = self.doc.resolve(enc.get("Differences"))
            if isinstance(diffs, list):
                code = 0
                for item in diffs:
                    item = self.doc.resolve(item)
                    if isinstance(item, (int, float)):
                        code = int(item)
                    elif isinstance(item, str):
                        self.diff[code] = str(item)
                        code += 1

    def _load_tounicode(self) -> None:
        tu = self.doc.d(self.dict, "ToUnicode")
        if not isinstance(tu, Stream):
            return
        try:
            body = tu.data()
        except Exception:
            return
        for m in re.finditer(rb"beginbfchar(.*?)endbfchar", body, re.S):
            for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", m.group(1)):
                self.to_unicode[int(src, 16)] = _utf16be(dst)
        for m in re.finditer(rb"beginbfrange(.*?)endbfrange", body, re.S):
            blk = m.group(1)
            for lo, hi, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
                lo_i, hi_i = int(lo, 16), int(hi, 16)
                base = int(dst, 16)
                for k in range(lo_i, min(hi_i, lo_i + 65535) + 1):
                    self.to_unicode[k] = chr(base + (k - lo_i))
            for lo, hi, arr in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[(.*?)\]", blk, re.S):
                lo_i = int(lo, 16)
                for i, d in enumerate(re.findall(rb"<([0-9A-Fa-f]+)>", arr)):
                    self.to_unicode[lo_i + i] = _utf16be(d)

    def _load_cid_widths(self) -> None:
        doc = self.doc
        desc_list = doc.d(self.dict, "DescendantFonts")
        desc = doc.resolve(desc_list[0]) if isinstance(desc_list, list) and desc_list else None
        if not isinstance(desc, dict):
            self.default_width = 1000.0
            return
        dw = doc.resolve(desc.get("DW"))
        self.default_width = float(dw) if isinstance(dw, (int, float)) else 1000.0
        w = doc.resolve(desc.get("W"))
        if not isinstance(w, list):
            return
        i = 0
        while i < len(w):
            a = doc.resolve(w[i])
            if i + 1 >= len(w):
                break
            b = doc.resolve(w[i + 1])
            if isinstance(b, list):
                for j, ww in enumerate(b):
                    ww = doc.resolve(ww)
                    if isinstance(ww, (int, float)):
                        self.widths[int(a) + j] = float(ww)
                i += 2
            else:
                if i + 2 < len(w):
                    c = doc.resolve(w[i + 2])
                    if isinstance(c, (int, float)) and isinstance(b, (int, float)):
                        for k in range(int(a), min(int(b), int(a) + 65535) + 1):
                            self.widths[k] = float(c)
                i += 3

    # -- use ---------------------------------------------------------------

    def codes(self, raw: bytes):
        """Split a string operand into character codes."""
        if self.two_byte:
            for i in range(0, len(raw) - 1, 2):
                yield (raw[i] << 8) | raw[i + 1]
        else:
            for b in raw:
                yield b

    def width(self, code: int) -> float:
        w = self.widths.get(code)
        return self.default_width if w is None else w

    def text(self, code: int) -> str:
        if code in self.to_unicode:
            return self.to_unicode[code]
        if code in self.diff:
            g = self.diff[code]
            if g in _GLYPH:
                return _GLYPH[g]
            m = re.fullmatch(r"uni([0-9A-Fa-f]{4})", g)
            if m:
                return chr(int(m.group(1), 16))
            m = re.fullmatch(r"[gGcC](\d+)", g)
            if m:
                return ""  # unnamed subset glyph -- no text meaning
            return g[:1] if len(g) == 1 else ""
        if self.two_byte:
            return chr(code) if 32 <= code < 0x3000 else ""
        if 32 <= code < 127:
            return chr(code)
        if code in _WIN_ANSI_HIGH and "WinAnsi" in (self.base_encoding or "WinAnsi"):
            return _WIN_ANSI_HIGH[code]
        if code >= 160:
            return bytes([code]).decode("latin-1")
        return ""


def _utf16be(h: bytes) -> str:
    raw = bytes.fromhex(h.decode("ascii"))
    if len(raw) % 2:
        raw += b"\x00"
    try:
        return raw.decode("utf-16-be")
    except UnicodeDecodeError:
        return ""


# --------------------------------------------------------------------------
# Content stream interpretation
# --------------------------------------------------------------------------


def _mul(a: tuple, b: tuple) -> tuple:
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return (
        a0 * b0 + a1 * b2,
        a0 * b1 + a1 * b3,
        a2 * b0 + a3 * b2,
        a2 * b1 + a3 * b3,
        a4 * b0 + a5 * b2 + b4,
        a4 * b1 + a5 * b3 + b5,
    )


IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


class Char:
    __slots__ = ("text", "x0", "x1", "baseline", "size")

    def __init__(self, text: str, x0: float, x1: float, baseline: float, size: float):
        self.text = text
        self.x0 = x0
        self.x1 = x1
        self.baseline = baseline
        self.size = size


def extract_chars(doc: PdfDocument, page: dict, depth: int = 0) -> list[Char]:
    """Run the page's content stream and return every glyph it paints."""
    content = doc.page_content(page)
    resources = doc.d(page, "Resources") or {}
    return _run(doc, content, resources, IDENTITY, depth)


def _run(doc: PdfDocument, content: bytes, resources: Any, base_ctm: tuple, depth: int) -> list[Char]:
    chars: list[Char] = []
    if depth > 8:
        return chars
    fonts_res = doc.d(resources, "Font") or {}
    xobjs = doc.d(resources, "XObject") or {}
    font_cache: dict[str, Font] = {}

    def get_font(nm: str) -> Font | None:
        if nm in font_cache:
            return font_cache[nm]
        fd = doc.d(fonts_res, nm) if isinstance(fonts_res, dict) else None
        if fd is None:
            return None
        f = Font(doc, fd)
        font_cache[nm] = f
        return f

    ctm = base_ctm
    stack: list[tuple] = []
    tm = tlm = IDENTITY
    font: Font | None = None
    size = 0.0
    tc = tw = 0.0
    th = 1.0
    trise = 0.0
    leading = 0.0
    render_mode = 0

    lex = Lexer(content, 0)
    operands: list = []
    parser = Parser(content, 0, doc)

    def show(raw: bytes) -> None:
        nonlocal tm
        if font is None or not isinstance(raw, bytes):
            return
        for code in font.codes(raw):
            w0 = font.width(code) / 1000.0
            trm = _mul((size * th, 0.0, 0.0, size, 0.0, trise), _mul(tm, ctm))
            x = trm[4]
            y = trm[5]
            scale_x = (trm[0] ** 2 + trm[1] ** 2) ** 0.5
            scale_y = (trm[2] ** 2 + trm[3] ** 2) ** 0.5
            glyph_w = w0 * scale_x
            if render_mode != 3:  # 3 == invisible (OCR layers)
                t = font.text(code)
                if t:
                    chars.append(Char(t, x, x + glyph_w, y, scale_y or abs(size)))
            word = tw if (code == 32 and not font.two_byte) else 0.0
            adv = (w0 * size + tc + word) * th
            tm = _mul((1.0, 0.0, 0.0, 1.0, adv, 0.0), tm)

    def show_array(arr: list) -> None:
        nonlocal tm
        for item in arr:
            if isinstance(item, bytes):
                show(item)
            elif isinstance(item, (int, float)):
                adv = -item / 1000.0 * size * th
                tm = _mul((1.0, 0.0, 0.0, 1.0, adv, 0.0), tm)

    while True:
        save = lex.pos
        tok = lex.read_token()
        if tok is None:
            break
        # Operands re-use the object parser; operators are bare keywords.
        if (
            tok in (b"<<", b"[")
            or tok.startswith(b"/")
            or tok.startswith(b"\x00LIT")
            or tok.startswith(b"\x00HEX")
            or NUM_RE.match(tok)
        ):
            parser.lex.pos = save
            try:
                operands.append(parser.parse())
            except Exception:
                operands.append(None)
            lex.pos = parser.lex.pos
            continue

        op = tok.decode("latin-1", "replace")

        if op == "BI":  # inline image -- skip to EI
            e = content.find(b"EI", lex.pos)
            lex.pos = (e + 2) if e != -1 else len(content)
            operands = []
            continue

        try:
            if op == "q":
                stack.append(ctm)
            elif op == "Q":
                if stack:
                    ctm = stack.pop()
            elif op == "cm" and len(operands) >= 6:
                ctm = _mul(tuple(float(v) for v in operands[-6:]), ctm)
            elif op == "BT":
                tm = tlm = IDENTITY
            elif op == "ET":
                tm = tlm = IDENTITY
            elif op == "Tf" and len(operands) >= 2:
                font = get_font(str(operands[-2]))
                size = float(operands[-1])
            elif op == "Td" and len(operands) >= 2:
                tlm = _mul((1.0, 0.0, 0.0, 1.0, float(operands[-2]), float(operands[-1])), tlm)
                tm = tlm
            elif op == "TD" and len(operands) >= 2:
                leading = -float(operands[-1])
                tlm = _mul((1.0, 0.0, 0.0, 1.0, float(operands[-2]), float(operands[-1])), tlm)
                tm = tlm
            elif op == "Tm" and len(operands) >= 6:
                tm = tlm = tuple(float(v) for v in operands[-6:])
            elif op == "T*":
                tlm = _mul((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
                tm = tlm
            elif op == "TL" and operands:
                leading = float(operands[-1])
            elif op == "Tc" and operands:
                tc = float(operands[-1])
            elif op == "Tw" and operands:
                tw = float(operands[-1])
            elif op == "Tz" and operands:
                th = float(operands[-1]) / 100.0
            elif op == "Ts" and operands:
                trise = float(operands[-1])
            elif op == "Tr" and operands:
                render_mode = int(operands[-1])
            elif op == "Tj" and operands:
                show(operands[-1])
            elif op == "TJ" and operands and isinstance(operands[-1], list):
                show_array(operands[-1])
            elif op == "'" and operands:
                tlm = _mul((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
                tm = tlm
                show(operands[-1])
            elif op == '"' and len(operands) >= 3:
                tw = float(operands[-3])
                tc = float(operands[-2])
                tlm = _mul((1.0, 0.0, 0.0, 1.0, 0.0, -leading), tlm)
                tm = tlm
                show(operands[-1])
            elif op == "Do" and operands:
                xo = doc.d(xobjs, str(operands[-1])) if isinstance(xobjs, dict) else None
                if isinstance(xo, Stream) and doc.resolve(xo.dict.get("Subtype")) == "Form":
                    mtx = doc.resolve(xo.dict.get("Matrix")) or [1, 0, 0, 1, 0, 0]
                    sub_ctm = _mul(tuple(float(doc.resolve(v)) for v in mtx), ctm)
                    sub_res = doc.resolve(xo.dict.get("Resources")) or resources
                    chars.extend(_run(doc, xo.data(), sub_res, sub_ctm, depth + 1))
        except (TypeError, ValueError):
            pass  # a malformed operand -- ignore the operator, keep going
        operands = []

    return chars


# --------------------------------------------------------------------------
# Blank detection
# --------------------------------------------------------------------------


def group_lines(chars: list[Char]) -> list[list[Char]]:
    """Bucket glyphs into text lines by baseline, each sorted left to right."""
    lines: list[list[Char]] = []
    for ch in sorted(chars, key=lambda c: (-c.baseline, c.x0)):
        for line in reversed(lines):
            if abs(line[0].baseline - ch.baseline) <= LINE_TOL:
                line.append(ch)
                break
        else:
            lines.append([ch])
    for line in lines:
        line.sort(key=lambda c: c.x0)
    return lines


def line_text(line: list[Char]) -> str:
    """Rebuild a line's text, inserting spaces where the glyph gap implies one."""
    out: list[str] = []
    prev: Char | None = None
    for ch in line:
        if prev is not None:
            gap = ch.x0 - prev.x1
            if gap > 0.22 * max(prev.size, 1.0) and not out[-1].endswith(" "):
                out.append(" ")
        out.append(ch.text)
        prev = ch
    return "".join(out)


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    if not n:
        return 0.0
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def find_runs(line: list[Char]) -> list[tuple[int, int]]:
    """Index ranges of the line that are leader runs, as [start, end).

    Runs are broken by any intervening non-space text, and by an advance wider
    than `RUN_BREAK_FACTOR` times the run's own median dot pitch.
    """
    # Group leader glyphs into stretches uninterrupted by real text. Spaces
    # between dots are tolerated here; a wide advance is caught below.
    groups: list[list[int]] = []
    current: list[int] = []
    for idx, ch in enumerate(line):
        if ch.text in LEADER_CHARS:
            current.append(idx)
        elif not ch.text.isspace():
            if current:
                groups.append(current)
            current = []
    if current:
        groups.append(current)

    runs: list[tuple[int, int]] = []
    for grp in groups:
        if len(grp) < 2:
            continue
        advances = [line[grp[k]].x0 - line[grp[k - 1]].x0 for k in range(1, len(grp))]
        pitch = _median([a for a in advances if a > 0]) or 0.0
        limit = RUN_BREAK_FACTOR * pitch if pitch > 0 else float("inf")
        piece = [grp[0]]
        for k in range(1, len(grp)):
            if advances[k - 1] > limit:
                if len(piece) >= MIN_RUN:
                    runs.append((piece[0], piece[-1] + 1))
                piece = []
            piece.append(grp[k])
        if len(piece) >= MIN_RUN:
            runs.append((piece[0], piece[-1] + 1))
    runs.sort()
    return runs


def clean_label(s: str) -> str:
    s = s.replace(" ", " ")
    s = re.sub(rf"[{re.escape(LEADER_CHARS)}]{{2,}}", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s.strip(" .:-–—")


def extract_blanks(doc: PdfDocument, form: str) -> tuple[list[dict], list[dict]]:
    blanks: list[dict] = []
    page_meta: list[dict] = []
    pages = doc.pages()
    for pno, page in enumerate(pages, start=1):
        media = doc.d(page, "MediaBox") or [0, 0, 612, 792]
        media = [float(doc.resolve(v)) for v in media]
        px0, py0, px1, py1 = media[0], media[1], media[2], media[3]
        pw, ph = abs(px1 - px0), abs(py1 - py0)
        rotate = doc.d(page, "Rotate") or 0
        page_meta.append(
            {
                "page": pno,
                "width": round(pw, 2),
                "height": round(ph, 2),
                "rotate": int(rotate) % 360,
                "mediaBox": [round(v, 2) for v in media[:4]],
            }
        )
        chars = extract_chars(doc, page)
        lines = group_lines(chars)
        for line in lines:
            runs = find_runs(line)
            if not runs:
                continue
            full = line_text(line)
            for ri, (a, b) in enumerate(runs):
                seg = line[a:b]
                dots = [c for c in seg if c.text in LEADER_CHARS]
                if not dots:
                    continue
                x0 = min(c.x0 for c in dots)
                x1 = max(c.x1 for c in dots)
                base = sum(c.baseline for c in dots) / len(dots)
                fsize = max(c.size for c in dots)
                before = clean_label("".join(c.text for c in line[:a]))
                after = clean_label("".join(c.text for c in line[b:]))
                blanks.append(
                    {
                        "id": f"{form}-p{pno}-b{len(blanks) + 1:03d}",
                        "name": None,  # curation fills this in
                        "page": pno,
                        "bbox": [round(x0, 2), round(base - 0.22 * fsize, 2), round(x1, 2), round(base + 0.78 * fsize, 2)],
                        "baseline": round(base, 2),
                        "width": round(x1 - x0, 2),
                        "fontSize": round(fsize, 2),
                        "runLength": len(dots),
                        "label": before,
                        "labelAfter": after,
                        "lineText": clean_label(full)[:300],
                        "runIndexOnLine": ri,
                        "runsOnLine": len(runs),
                    }
                )
    return blanks, page_meta


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------


def build(pdf_path: Path, form: str) -> dict:
    data = pdf_path.read_bytes()
    doc = PdfDocument(data)
    blanks, page_meta = extract_blanks(doc, form)
    return {
        "form": form,
        "source": pdf_path.name,
        # The fill engine refuses to draw when this stops matching: OREA
        # revises forms and the coordinates move without the name changing.
        "sourceSha256": hashlib.sha256(data).hexdigest(),
        "generator": "tools/extract_template.py",
        "coordinateSpace": "pdf-user-space-origin-bottom-left",
        "units": "pt",
        "extraction": {
            "minRunLength": MIN_RUN,
            "leaderChars": LEADER_CHARS,
            "lineTolerance": LINE_TOL,
            "runBreakFactor": RUN_BREAK_FACTOR,
        },
        "pageCount": len(page_meta),
        "pages": page_meta,
        "blankCount": len(blanks),
        "blanks": blanks,
    }


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(
        description="Extract dot-leader blanks from a flattened OREA form PDF.",
    )
    ap.add_argument("pdf", type=Path, help="source PDF (forms/sources/...)")
    ap.add_argument("form", help="form number, e.g. 100")
    ap.add_argument("-o", "--out", type=Path, default=None, help="output path")
    ap.add_argument("--stdout", action="store_true", help="write JSON to stdout instead of a file")
    ap.add_argument("--summary", action="store_true", help="print a per-page count to stderr")
    args = ap.parse_args(argv)

    if not args.pdf.is_file():
        print(f"error: no such file: {args.pdf}", file=sys.stderr)
        return 2

    doc_json = build(args.pdf, args.form)

    if args.summary:
        per: dict[int, int] = {}
        for b in doc_json["blanks"]:
            per[b["page"]] = per.get(b["page"], 0) + 1
        for p in sorted(per):
            print(f"  page {p}: {per[p]} blanks", file=sys.stderr)
        print(f"  total: {doc_json['blankCount']}", file=sys.stderr)

    text = json.dumps(doc_json, indent=2, ensure_ascii=False) + "\n"
    if args.stdout:
        sys.stdout.write(text)
        return 0

    out = args.out or Path("forms/templates") / f"{args.form}.raw.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    print(f"{out}: {doc_json['blankCount']} blanks across {doc_json['pageCount']} pages", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
