#!/bin/sh
# take-export.sh <unit id>: registers the newest GLB in ~/Downloads as that unit's model. A file is taken once: the
# names already used are kept in _notes/arena-models/taken.txt, so an export that did not arrive is noticed.
set -e
root="$(dirname "$0")/../.."
taken="$root/_notes/arena-models/taken.txt"
touch "$taken"
newest=$(ls -t "$HOME"/Downloads/*.glb | head -1)
if grep -qxF "$(basename "$newest")" "$taken"; then echo "no new export: $(basename "$newest") was already used"; exit 1; fi
python3 -I "$(dirname "$0")/add-unit.py" "$1" "$newest"
basename "$newest" >> "$taken"
