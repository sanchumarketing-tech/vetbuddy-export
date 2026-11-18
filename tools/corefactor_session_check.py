#!/usr/bin/env python3
"""Read-only: is the Corefactor session id (COREFACTOR_SESSIONID) still signed in? Opens the Call Logs page only."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import corefactor_calllogs_export as cf  # noqa: E402

cf.setup_logging()
c = cf.Corefactor(cf.env("COREFACTOR_BASE_URL", "https://tw1.teleduce.corefactors.in"), cf.env("COREFACTOR_SESSIONID", required=True).strip())
try:
    c.open_call_logs()
    cf.log.info("SESSION VALID")
except cf.RunError as e:
    cf.log.error("SESSION NOT VALID: %s", e)
    sys.exit(1)
