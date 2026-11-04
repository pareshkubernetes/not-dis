#!/usr/bin/env bash
# recreate-app.sh
#
# Writes every file stored in all-app-code.txt into the current folder (or the folder you name).
#
# Usage (run it in the folder where the application should be created):
#     bash recreate-app.sh -f                    # reads ./all-app-code.txt and overwrites existing files
#     bash recreate-app.sh -f bundle.txt         # another input file name
#     bash recreate-app.sh bundle.txt ./out      # write into ./out (existing files that differ are kept without -f)
#     bash recreate-app.sh -l                    # list the files in the bundle
#     bash recreate-app.sh -n                    # dry run: show what would happen, write nothing
#
# Without -f, files that already exist and differ are reported and skipped.
# The bundle is verified against its SHA-256 checksums before anything is written.
# A bundle that was converted to Windows line endings (CRLF) by an editor or e-mail is still read correctly.

set -euo pipefail
export LC_ALL=C

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

WORK=""
# Removes only the staging folder this run created itself (its name always starts with recreate-app.).
cleanup() {
  case "$WORK" in
    */recreate-app.??????) [ -d "$WORK" ] && rm -rf -- "$WORK" ;;
  esac
  return 0
}

usage() { sed -n '2,15p' "$SELF" | sed 's/^# \{0,1\}//'; }

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

main() {
  local FORCE=0 DRY=0 LIST=0 arg
  local POS=()
  for arg in "$@"; do
    case "$arg" in
      -f|--force) FORCE=1 ;;
      -n|--dry-run) DRY=1 ;;
      -l|--list) LIST=1 ;;
      -h|--help) usage; return 0 ;;
      -*) echo "ERROR: unknown option: $arg" >&2; return 1 ;;
      *) POS+=("$arg") ;;
    esac
  done

  local IN="${POS[0]:-all-app-code.txt}"
  local DEST="${POS[1]:-.}"
  [ -f "$IN" ] || { echo "ERROR: input file not found: $IN" >&2; return 1; }
  command -v sha256sum >/dev/null 2>&1 || command -v shasum >/dev/null 2>&1 \
    || { echo "ERROR: sha256sum or shasum is required" >&2; return 1; }

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/recreate-app.XXXXXX")"
  trap cleanup EXIT

  # Pass 1: split the bundle into a staging folder and read the checksum table.
  local line current="" count=0 in_sums=0
  : > "$WORK/sums"
  : > "$WORK/files"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    if [ -n "$current" ]; then
      if [ "$line" = "@@END" ]; then current=""; continue; fi
      printf '%s\n' "$line" >> "$WORK/stage/$current"
      continue
    fi
    case "$line" in
      "@@FILE "*)
        current="${line#@@FILE }"
        case "$current" in
          /*|*..*|"") echo "ERROR: unsafe path in bundle: $current" >&2; return 1 ;;
        esac
        mkdir -p "$WORK/stage/$(dirname "$current")"
        : > "$WORK/stage/$current"
        echo "$current" >> "$WORK/files"
        count=$((count + 1))
        ;;
      "@@CHECKSUMS") in_sums=1 ;;
      *) if [ "$in_sums" = 1 ] && [ -n "$line" ]; then echo "$line" >> "$WORK/sums"; fi ;;
    esac
  done < "$IN"
  [ -z "$current" ] || { echo "ERROR: bundle is truncated (missing @@END after $current)" >&2; return 1; }
  [ "$count" -gt 0 ] || { echo "ERROR: no files found in $IN" >&2; return 1; }

  if [ "$LIST" = 1 ]; then cat "$WORK/files"; echo "$count files"; return 0; fi

  # Pass 2: verify every file against its checksum before anything is written.
  local expected path actual bad=0
  while IFS= read -r path; do
    expected="$(awk -v p="$path" '$2 == p { print $1 }' "$WORK/sums")"
    if [ -z "$expected" ]; then echo "ERROR: no checksum for $path" >&2; bad=1; continue; fi
    actual="$(sha_of "$WORK/stage/$path")"
    if [ "$actual" != "$expected" ]; then echo "ERROR: checksum mismatch: $path" >&2; bad=1; fi
  done < "$WORK/files"
  [ "$bad" = 0 ] || { echo "Nothing was written. Re-copy the bundle file and try again." >&2; return 1; }

  # Pass 3: write.
  local created=0 updated=0 same=0 skipped=0 target
  while IFS= read -r path; do
    target="$DEST/$path"
    if [ -e "$target" ]; then
      if cmp -s "$WORK/stage/$path" "$target"; then same=$((same + 1)); continue; fi
      if [ "$FORCE" = 0 ]; then
        echo "skipped (differs, use -f to overwrite): $path"
        skipped=$((skipped + 1))
        continue
      fi
      echo "update:  $path"; updated=$((updated + 1))
    else
      echo "create:  $path"; created=$((created + 1))
    fi
    if [ "$DRY" = 0 ]; then
      mkdir -p "$(dirname "$target")"
      cp "$WORK/stage/$path" "$target"
    fi
  done < "$WORK/files"

  echo
  echo "$created created, $updated updated, $same unchanged, $skipped skipped${DRY:+ }$([ "$DRY" = 1 ] && echo '(dry run, nothing written)')"
  if [ "$DRY" = 0 ] && [ "$((created + updated))" -gt 0 ]; then
    echo
    echo "Next:  cd \"$DEST\" && cp .env.example .env   (then edit .env)"
    echo "       npm install && npm start      (npm test runs the tests)"
  fi
}

main "$@"
exit $?
