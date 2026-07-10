"""Thin wrapper around the swimparse CLI.

swimparse is the single source of truth for SDIF/HY3 parsing (it lives at
../swimparse and is shared with the browser tools). Rather than re-implement any
fixed-width offsets in Python, we shell out to its Node CLI and consume the
NormalizedMeet JSON it prints.

We always pass ``--league gpsa`` so the output is DOB-free (birthdates stripped,
age groups computed) — the relay tool never needs raw birthdates, only the age
group, so no minors' PII is ever stored.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

# Default resolves to app-tools/swimparse/cli.js when running from source; the
# Docker image sets SWIMPARSE_CLI explicitly to the copied-in location.
_DEFAULT_CLI = Path(__file__).resolve().parents[2] / "swimparse" / "cli.js"
SWIMPARSE_CLI = os.environ.get("SWIMPARSE_CLI") or str(_DEFAULT_CLI)
NODE = os.environ.get("NODE_BIN", "node")


class SwimparseError(RuntimeError):
    """swimparse failed to parse a file."""


def parse_meet(path: str | os.PathLike) -> dict:
    """Parse one .sd3/.hy3 file into a NormalizedMeet dict (DOB-free)."""
    try:
        proc = subprocess.run(
            [NODE, SWIMPARSE_CLI, str(path), "--league", "gpsa"],
            capture_output=True,
            text=True,
            check=True,
        )
    except FileNotFoundError as exc:  # node not on PATH
        raise SwimparseError(f"could not run swimparse ({NODE}): {exc}") from exc
    except subprocess.CalledProcessError as exc:
        raise SwimparseError(exc.stderr.strip() or "swimparse exited non-zero") from exc

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise SwimparseError(f"swimparse produced invalid JSON: {exc}") from exc
