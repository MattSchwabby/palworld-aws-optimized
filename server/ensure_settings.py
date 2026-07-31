#!/usr/bin/env python3
"""Enforce the settings this deployment depends on, without clobbering the rest.

Palworld keeps every setting as one long parenthesised tuple on a single
`OptionSettings=` line. Regenerating that file wholesale would throw away any
in-game tuning you have done, and a save restored from S3 brings its own copy
along. So: parse the tuple, overwrite only the keys we require, leave everything
else exactly as found.

RESTAPIEnabled is the load-bearing one — idle shutdown, pre-backup saves, and
graceful stop all go through that API. A restored config without it would leave
the server running until the CloudWatch backstop noticed.

Usage: ensure_settings.py <ini-path> <json-of-keys-to-set>
"""

import json
import os
import sys

SECTION = "[/Script/Pal.PalGameWorldSettings]"
PREFIX = "OptionSettings=("


def split_top_level(text):
    """Split on commas that are not inside a quoted string."""
    fields, current, in_quotes = [], [], False

    for char in text:
        if char == '"':
            in_quotes = not in_quotes
            current.append(char)
        elif char == "," and not in_quotes:
            fields.append("".join(current))
            current = []
        else:
            current.append(char)

    if current:
        fields.append("".join(current))

    return [field for field in (f.strip() for f in fields) if field]


def parse(path):
    """Return the existing settings as an ordered dict, or empty if there is no file."""
    if not os.path.exists(path):
        return {}

    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith(PREFIX):
                continue

            inner = line[len(PREFIX):]
            if inner.endswith(")"):
                inner = inner[:-1]

            settings = {}
            for field in split_top_level(inner):
                key, separator, value = field.partition("=")
                if separator:
                    settings[key.strip()] = value.strip()
            return settings

    return {}


def main(argv):
    if len(argv) != 3:
        print("usage: ensure_settings.py <ini-path> <json>", file=sys.stderr)
        return 2

    path, overrides = argv[1], json.loads(argv[2])

    settings = parse(path)
    settings.update(overrides)

    body = ",".join(f"{key}={value}" for key, value in settings.items())

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(f"{SECTION}\n{PREFIX}{body})\n")

    print(f"wrote {len(settings)} settings to {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
