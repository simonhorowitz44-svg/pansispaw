#!/usr/bin/env python3
"""
Regenerate images/gallery/photos.json from whatever images are in this folder.

Usage:
    python3 images/gallery/regenerate.py

This script:
  - Scans this folder for .jpg, .jpeg, .png, .webp files
  - Generates a sorted photos.json with sensible alt text from the filename
  - Preserves any existing custom alt text from photos.json
"""

import json
import os
import re
from pathlib import Path

GALLERY_DIR = Path(__file__).parent
IMAGE_EXTS = {'.jpg', '.jpeg', '.png', '.webp'}
MANIFEST = GALLERY_DIR / 'photos.json'


def filename_to_alt(filename: str) -> str:
    """Turn 'pansi-zoomies.jpg' into 'Pansi zoomies'."""
    stem = Path(filename).stem
    # Strip leading numbers like '01-' or '12_'
    stem = re.sub(r'^\d+[-_]', '', stem)
    # Replace separators with spaces
    stem = stem.replace('-', ' ').replace('_', ' ')
    # Capitalise first letter only (preserve mid-word case)
    return stem[:1].upper() + stem[1:] if stem else 'Pansi\'s Paws'


def main():
    # Load existing manifest (to preserve custom alt text)
    existing = {}
    if MANIFEST.exists():
        try:
            for entry in json.loads(MANIFEST.read_text()):
                existing[entry['file']] = entry.get('alt', '')
        except Exception:
            pass

    # Scan folder
    files = []
    for f in sorted(GALLERY_DIR.iterdir()):
        if f.is_file() and f.suffix.lower() in IMAGE_EXTS:
            files.append(f.name)

    # Build new manifest
    new_manifest = []
    for filename in files:
        alt = existing.get(filename) or filename_to_alt(filename)
        new_manifest.append({'file': filename, 'alt': alt})

    MANIFEST.write_text(json.dumps(new_manifest, indent=2) + '\n')

    print(f'Wrote {len(new_manifest)} photos to {MANIFEST.name}:')
    for entry in new_manifest:
        print(f'  - {entry["file"]}  ({entry["alt"]})')


if __name__ == '__main__':
    main()
