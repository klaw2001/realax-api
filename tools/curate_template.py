#!/usr/bin/env python3
"""Merge extractor output with a hand-written curation into a fill-ready template.

`extract_template.py` finds every dot-leader run in an OREA form and gives each
one an id, a page and a bounding box. It cannot know what any of them *mean* —
that is the curation, and it is done by hand once per form revision in
`forms/templates/<form>.names.json`.

This joins the two:

    tools/curate_template.py 100

    forms/templates/100.raw.json     ← extractor output, regenerable
  + forms/templates/100.names.json   ← the curation, hand written
  = forms/templates/100.json         ← what the service loads

Keeping the curation in its own small file is what makes an OREA revision
survivable. Re-run the extractor, re-run this, and the ids that moved show up
as coverage errors instead of as a form that fills the completion date into the
title search blank.

Refuses to write on: a hash disagreement between the two inputs, a blank the
curation does not name, a name the extractor does not have a blank for, or a
duplicated name. Stdlib only, same as the extractor.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

# Split between what the compliance gate checks before signing and what a signer
# supplies inside the e-sign session (build plan 2.4 and 3.1). A signature blank
# being empty pre-send is correct, not a missing field.
KINDS = {"data", "signature", "signingDate"}

# Extraction diagnostics. Useful when the curation is being written or an OREA
# revision has to be re-reconciled; noise in the file the fill engine loads.
DIAGNOSTIC_KEYS = ("runLength", "runIndexOnLine", "runsOnLine")

TEMPLATES = Path(__file__).resolve().parent.parent / "forms" / "templates"
SOURCES = Path(__file__).resolve().parent.parent / "forms" / "sources"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)

    return digest.hexdigest()


def curate(form: str, verify_source: bool) -> dict:
    raw_path = TEMPLATES / f"{form}.raw.json"
    names_path = TEMPLATES / f"{form}.names.json"

    raw = json.loads(raw_path.read_text())
    curation = json.loads(names_path.read_text())

    errors: list[str] = []

    # The curation names blanks by id, and ids are only stable for one revision
    # of one PDF. If the hashes disagree, one of the two files is stale and the
    # ids in it mean something else.
    if raw["sourceSha256"] != curation["sourceSha256"]:
        errors.append(
            f"sourceSha256 disagrees: {raw_path.name} has {raw['sourceSha256'][:12]}…, "
            f"{names_path.name} has {curation['sourceSha256'][:12]}…"
        )

    # And the PDF on disk has to be the one both of them were written against.
    if verify_source:
        source_path = SOURCES / raw["source"]
        if not source_path.exists():
            errors.append(f"source PDF missing: forms/sources/{raw['source']}")
        else:
            on_disk = sha256_file(source_path)
            if on_disk != raw["sourceSha256"]:
                errors.append(
                    f"source PDF has changed: on disk {on_disk[:12]}…, template pinned to {raw['sourceSha256'][:12]}…"
                )

    named = curation["blanks"]
    extracted = {blank["id"]: blank for blank in raw["blanks"]}

    uncurated = sorted(set(extracted) - set(named))
    if uncurated:
        errors.append(f"{len(uncurated)} blank(s) not named by the curation: {', '.join(uncurated)}")

    orphaned = sorted(set(named) - set(extracted))
    if orphaned:
        errors.append(f"{len(orphaned)} curated id(s) the extractor did not find: {', '.join(orphaned)}")

    seen: dict[str, str] = {}
    for blank_id, entry in sorted(named.items()):
        name = entry.get("name")
        kind = entry.get("kind")

        if not name:
            errors.append(f"{blank_id}: no name")
        elif name in seen:
            # Two blanks sharing a name means the fill engine writes one value
            # into two places, which is occasionally right and never accidental.
            errors.append(f"{blank_id}: name '{name}' already used by {seen[name]}")
        else:
            seen[name] = blank_id

        if kind not in KINDS:
            errors.append(f"{blank_id}: kind {kind!r} is not one of {sorted(KINDS)}")

    if errors:
        raise SystemExit("curation failed:\n  - " + "\n  - ".join(errors))

    blanks = []
    for blank in raw["blanks"]:
        entry = named[blank["id"]]
        merged = {key: value for key, value in blank.items() if key not in DIAGNOSTIC_KEYS}
        merged["name"] = entry["name"]
        merged["kind"] = entry["kind"]
        # Optional per-blank fill hints. Absent for almost every blank; the fill
        # engine's defaults are derived from the bounding box.
        for optional in ("align", "maxLength", "note"):
            if optional in entry:
                merged[optional] = entry[optional]
        blanks.append(merged)

    return {
        "form": raw["form"],
        "revision": curation["revision"],
        "source": raw["source"],
        "sourceSha256": raw["sourceSha256"],
        "generator": "tools/curate_template.py",
        "coordinateSpace": raw["coordinateSpace"],
        "units": raw["units"],
        "extraction": raw["extraction"],
        "pageCount": raw["pageCount"],
        "pages": raw["pages"],
        "blankCount": len(blanks),
        "blanks": blanks,
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("form", help="form number, e.g. 100")
    parser.add_argument("-o", "--out", type=Path, default=None, help="output path")
    parser.add_argument("--stdout", action="store_true", help="write to stdout instead of a file")
    parser.add_argument(
        "--no-verify-source",
        action="store_true",
        help="skip hashing the PDF (for a checkout without forms/sources)",
    )
    args = parser.parse_args(argv)

    template = curate(args.form, verify_source=not args.no_verify_source)
    payload = json.dumps(template, indent=2) + "\n"

    if args.stdout:
        sys.stdout.write(payload)
    else:
        out = args.out or TEMPLATES / f"{args.form}.json"
        out.write_text(payload)
        counts: dict[str, int] = {}
        for blank in template["blanks"]:
            counts[blank["kind"]] = counts.get(blank["kind"], 0) + 1
        summary = ", ".join(f"{count} {kind}" for kind, count in sorted(counts.items()))
        print(f"{out}: {template['blankCount']} blanks ({summary})", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
