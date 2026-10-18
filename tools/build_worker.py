#!/usr/bin/env python3
"""Nothing to build any more: Cloudflare serves public/ as static assets and runs src/worker.js.
Kept so that a Cloudflare build command set to `python3 tools/build_worker.py` keeps working;
you can clear that build command in the Worker's Settings → Build."""
print("Nothing to build: public/ and src/worker.js are deployed as they are.")
