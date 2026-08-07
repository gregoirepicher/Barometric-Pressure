#!/usr/bin/env python3
"""Merge symptom-log backups from the phone into the permanent archive.

The phone holds the live copy in browser storage; this script is the receiving
end. Save the .json backup that arrives by email or share sheet, run it through
here, and commit the result -- git then holds the full history.

    python import_backup.py ~/Downloads/symptom-log-2026-08-06.json
    python import_backup.py backups/*.json --dry-run
    python import_backup.py backup.json --csv

Merging is keyed by date, and for any date the most recently updated version
wins. That makes the operation safe to repeat: importing the same file twice,
or importing an older backup after a newer one, cannot lose data. Entries are
never deleted -- a date missing from a backup is left alone, because a backup
taken before that day existed is not evidence the day was erased.
"""

import argparse
import csv
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone

ARCHIVE_PATH = os.path.join("data", "symptom-history.json")
ARCHIVE_KIND = "bp-symptom-log-archive"

# v2: every question runs 0 (best) to 10 (worst). v1 mixed directions and ran
# 1-10. Mirrors the migration in static/symptoms.js.
SCHEMA_VERSION = 2

# Must stay in step with QUESTIONS in static/symptoms.js. Adding a question
# there means adding it here, otherwise the CSV silently drops the column.
QUESTION_KEYS = ["headPain", "bodyPain", "cognitive", "ambulatory", "overall"]

# Questions whose v1 scale ran the opposite way (10 was best).
V1_INVERTED_KEYS = {"cognitive", "ambulatory", "overall"}

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

PRESSURE_COLUMNS = [
    ("pressure_mean", "mean"),
    ("pressure_min", "min"),
    ("pressure_max", "max"),
    ("pressure_range", "range"),
    ("pressure_max_drop_3h", "maxDrop3h"),
    ("pressure_city", "city"),
]


def warn(message):
    """Report to stderr without letting it jump ahead of buffered stdout."""
    sys.stdout.flush()
    print(message, file=sys.stderr)
    sys.stderr.flush()


def snake_case(name):
    return re.sub(r"[A-Z]", lambda m: "_" + m.group(0).lower(), name)


def is_valid_date_key(key):
    if not DATE_RE.match(key):
        return False
    try:
        datetime.strptime(key, "%Y-%m-%d")
    except ValueError:
        return False
    return True


def looks_like_entry(key, entry):
    """Mirror of looksLikeEntry() in static/symptoms.js."""
    if not is_valid_date_key(key):
        return False
    if not isinstance(entry, dict):
        return False
    has_score = any(isinstance(entry.get(k), (int, float))
                    and not isinstance(entry.get(k), bool)
                    for k in QUESTION_KEYS)
    return has_score or isinstance(entry.get("notes"), str)


def count_of(n, one, many):
    return f"{n} {one if n == 1 else many}"


def clamp_score(value):
    return max(0, min(10, int(round(value))))


def migrate_v1_entries(entries):
    """Convert a v1 (1-10, mixed direction) map to v2 (0-10, 10 always worst).

    Reinterpreting rather than converting would invert meaning: an old
    "cognitive ability 9" (nearly normal) would read as "difficulty 9"
    (severely impaired). Mirrors migrateV1ToV2() in static/symptoms.js.
    """
    out = {}
    for key, src in entries.items():
        if not isinstance(src, dict):
            continue
        entry = dict(src)
        for q in QUESTION_KEYS:
            v = src.get(q)
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                entry[q] = None
            elif q in V1_INVERTED_KEYS:
                entry[q] = clamp_score(10 - v)
            else:
                entry[q] = clamp_score(v - 1)
        entry["migratedFrom"] = "v1"
        out[key] = entry
    return out


def _unwrap(parsed, source):
    """Return (entries, schema) from a backup or archive payload.

    Accepts a full file ({"kind": ..., "entries": {...}}) or a bare
    {"YYYY-MM-DD": {...}} map, matching what the browser importer accepts.
    """
    if isinstance(parsed, dict) and isinstance(parsed.get("entries"), dict):
        return parsed["entries"], parsed.get("schema") or parsed.get("version")
    if isinstance(parsed, dict):
        # A hand-made bare map carries no version. Assuming the current schema
        # is the safer default -- guessing v1 would invert correct data.
        warn(f"  ? {os.path.basename(source)}: no schema field; assuming v{SCHEMA_VERSION}")
        return parsed, SCHEMA_VERSION
    raise ValueError("expected a JSON object, got a " + type(parsed).__name__)


def read_entries(path):
    with open(path, "r", encoding="utf-8-sig") as fh:
        try:
            parsed = json.load(fh)
        except json.JSONDecodeError as exc:
            raise ValueError(f"not valid JSON ({exc.msg} at line {exc.lineno})")
    return _unwrap(parsed, path)


def load_archive(path):
    if not os.path.exists(path):
        return {}, SCHEMA_VERSION
    with open(path, "r", encoding="utf-8-sig") as fh:
        parsed = json.load(fh)
    try:
        return _unwrap(parsed, path)
    except ValueError:
        raise ValueError(f"{path} is not a readable archive")


def merge(archive, incoming, source, stats):
    """Merge one backup's entries into `archive` in place."""
    for key in sorted(incoming):
        entry = incoming[key]

        if not looks_like_entry(key, entry):
            stats["skipped"].append((source, key))
            continue

        entry = dict(entry)
        entry["date"] = key
        current = archive.get(key)

        if current is None:
            archive[key] = entry
            stats["added"].append(key)
            continue

        inc_at = entry.get("updatedAt") or ""
        cur_at = current.get("updatedAt") or ""

        if inc_at and inc_at > cur_at:
            archive[key] = entry
            stats["updated"].append(key)
        elif inc_at and inc_at == cur_at and _differs(current, entry):
            # Same timestamp, different content: two devices edited the same
            # day independently. Keeping what's already archived is the
            # conservative choice, but it needs to be visible, not silent.
            stats["conflicts"].append(key)
        else:
            stats["unchanged"].append(key)


def _differs(a, b):
    comparable = QUESTION_KEYS + ["notes"]
    return any(a.get(k) != b.get(k) for k in comparable)


def write_json_atomic(path, payload):
    """Write via a temp file + replace so an interrupted run can't truncate
    the archive."""
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)

    fd, tmp = tempfile.mkstemp(dir=directory, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(payload, fh, indent=2, sort_keys=True, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def write_archive(path, archive):
    payload = {
        "kind": ARCHIVE_KIND,
        "schema": SCHEMA_VERSION,
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "entryCount": len(archive),
        # sort_keys in write_json_atomic keeps dates ordered, so a commit
        # diff shows only the days that actually changed.
        "entries": archive,
    }
    write_json_atomic(path, payload)


def write_csv(path, archive):
    header = (["date"]
              + [snake_case(k) for k in QUESTION_KEYS]
              + ["notes"]
              + [col for col, _ in PRESSURE_COLUMNS]
              + ["created_at", "updated_at"])

    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)

    # utf-8-sig so Excel renders accented notes correctly.
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for key in sorted(archive):
            entry = archive[key]
            pressure = entry.get("pressure") or {}
            row = ([key]
                   + [entry.get(k) for k in QUESTION_KEYS]
                   + [entry.get("notes", "")]
                   + [pressure.get(src) for _, src in PRESSURE_COLUMNS]
                   + [entry.get("createdAt"), entry.get("updatedAt")])
            writer.writerow(["" if v is None else v for v in row])


def summarise(stats, archive, verbose):
    def show(label, keys):
        if not keys:
            return
        line = f"  {len(keys):>4}  {label}"
        if verbose:
            line += "\n" + "\n".join(f"          {k}" for k in sorted(keys))
        elif len(keys) <= 6:
            line += "  (" + ", ".join(sorted(keys)) + ")"
        print(line)

    print("")
    show("added", stats["added"])
    show("updated", stats["updated"])
    show("already up to date", stats["unchanged"])

    if stats["conflicts"]:
        show("CONFLICT - same timestamp, different content (kept archived "
             "version)", stats["conflicts"])

    if stats["skipped"]:
        print(f"  {len(stats['skipped']):>4}  skipped as unreadable")
        if verbose:
            for source, key in stats["skipped"]:
                print(f"          {key}  (from {os.path.basename(source)})")

    if archive:
        dates = sorted(archive)
        span = f"{dates[0]} to {dates[-1]}" if len(dates) > 1 else dates[0]
        noun = "day" if len(archive) == 1 else "days"
        print(f"\nArchive now holds {len(archive)} {noun}, {span}.")
    else:
        print("\nArchive is empty.")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Merge symptom-log backups into the permanent archive.")
    parser.add_argument("backups", nargs="+",
                        help="one or more backup .json files from the phone")
    parser.add_argument("--archive", default=ARCHIVE_PATH,
                        help=f"archive to merge into (default: {ARCHIVE_PATH})")
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would change without writing")
    parser.add_argument("--csv", action="store_true",
                        help="also write a CSV alongside the archive")
    parser.add_argument("-v", "--verbose", action="store_true",
                        help="list every affected date")
    args = parser.parse_args(argv)

    try:
        archive, archive_schema = load_archive(args.archive)
    except (ValueError, json.JSONDecodeError) as exc:
        warn(f"Could not read archive {args.archive}: {exc}")
        return 1

    before = len(archive)
    print(f"Archive: {args.archive} ({count_of(before, 'day', 'days')})")

    archive_migrated = False
    if archive and (archive_schema or 1) < SCHEMA_VERSION:
        archive = migrate_v1_entries(archive)
        archive_migrated = True
        print(f"  * archive was v{archive_schema}; converted "
              f"{count_of(len(archive), 'entry', 'entries')} to the 0-10 scale")

    stats = {"added": [], "updated": [], "unchanged": [],
             "conflicts": [], "skipped": []}
    read_any = False

    for path in args.backups:
        try:
            incoming, schema = read_entries(path)
        except FileNotFoundError:
            warn(f"  ! {path}: no such file")
            continue
        except (ValueError, OSError) as exc:
            warn(f"  ! {path}: {exc}")
            continue

        read_any = True
        note = ""
        if (schema or 1) < SCHEMA_VERSION:
            # Convert before merging, or the newest-wins comparison would be
            # picking between two different scales.
            incoming = migrate_v1_entries(incoming)
            note = f"  [v{schema} -> v{SCHEMA_VERSION}]"
        print(f"  + {os.path.basename(path)} "
              f"({count_of(len(incoming), 'entry', 'entries')}){note}")
        merge(archive, incoming, path, stats)

    if not read_any:
        warn("\nNo readable backups. Archive untouched.")
        return 1

    summarise(stats, archive, args.verbose)

    changed = len(stats["added"]) + len(stats["updated"])
    if args.dry_run:
        print("\nDry run - nothing written.")
        return 0

    # A schema conversion is itself a change worth persisting, even when no
    # entries were added -- otherwise the archive stays on the old scale and
    # the conversion is silently redone on every future run.
    if not changed and not archive_migrated:
        print("\nNothing to write.")
        return 0

    write_archive(args.archive, archive)
    print(f"\nWrote {args.archive}")

    written = [args.archive]
    if args.csv:
        csv_path = os.path.splitext(args.archive)[0] + ".csv"
        write_csv(csv_path, archive)
        print(f"Wrote {csv_path}")
        written.append(csv_path)

    print("\nCommit it to keep the history safe:")
    print("  git add " + " ".join(written))
    print("  git commit -m \"Import symptom log backup\"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
