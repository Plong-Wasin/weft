#!/usr/bin/env bash
set -euo pipefail

# Disposable, non-root probe of the SRT command wrapper. Nothing is installed
# globally and all generated files live below RUN_DIR.
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/weft-sandbox-prototype.XXXXXX")"
trap 'python3 - "$ROOT" <<'PY'
import shutil, sys
shutil.rmtree(sys.argv[1], ignore_errors=True)
PY' EXIT
RUN_DIR="$ROOT/run"
mkdir -p "$RUN_DIR/private"
printf 'synthetic Weft config\n' > "$RUN_DIR/private/weft-config"
printf 'synthetic SSH key\n' > "$RUN_DIR/private/ssh-key"

if ! command -v bwrap >/dev/null || ! command -v socat >/dev/null || ! command -v rg >/dev/null; then
  echo 'missing SRT dependency; install bwrap, socat and ripgrep locally or ask an administrator' >&2
  exit 2
fi

TOOL_DIR="$ROOT/tool"
npm install --prefix "$TOOL_DIR" --no-save --silent @anthropic-ai/sandbox-runtime@0.0.83
SRT="$TOOL_DIR/node_modules/.bin/srt"
SETTINGS="$ROOT/srt-settings.json"
python3 - "$RUN_DIR" "$SETTINGS" "${WEFT_TEST_URL:-}" <<'PY'
import json, os, sys
from urllib.parse import urlparse
run_dir, settings, weft_url = sys.argv[1:]
home = os.path.expanduser('~')
domains = [
    'api.anthropic.com', 'statsig.anthropic.com', 'sentry.io',
    'api.openai.com', 'auth.openai.com', 'chatgpt.com', '*.chatgpt.com',
    'github.com', '*.github.com', 'api.github.com', 'lfs.github.com',
    'localhost',
]
if weft_url:
    parsed_weft_url = urlparse(weft_url)
    weft_host = parsed_weft_url.hostname
    if not weft_host:
        raise SystemExit('WEFT_TEST_URL must be an absolute URL')
    domains.append(f'{weft_host}:{parsed_weft_url.port}' if parsed_weft_url.port else weft_host)
json.dump({
    'network': {
        'allowedDomains': domains,
        'deniedDomains': [],
    },
    'filesystem': {
        'denyRead': [
            os.path.join(home, '.config/weft'), os.path.join(home, '.ssh'),
            os.path.join(home, '.aws'), os.path.join(home, '.azure'),
            os.path.join(home, '.config/gcloud'),
            os.path.join(run_dir, 'private/weft-config'),
            os.path.join(run_dir, 'private/ssh-key'),
        ],
        'allowRead': [run_dir],
        'allowWrite': [run_dir],
        'denyWrite': [],
    },
}, open(settings, 'w'))
PY

echo 'Check: sandboxed Run directory is writable'
"$SRT" --settings "$SETTINGS" -- sh -c 'printf ok > "$1/inside" && test "$(cat "$1/inside")" = ok' sh "$RUN_DIR"

echo 'Check: write outside Run directory is denied'
if "$SRT" --settings "$SETTINGS" -- sh -c 'printf bad > "$1/outside"' sh "$ROOT" 2>/dev/null; then
  echo 'FAIL: outside write succeeded' >&2; exit 1
else
  echo 'PASS: outside write denied'
fi

echo 'Check: Weft config and SSH key reads are denied'
"$SRT" --settings "$SETTINGS" -- sh -c '
  for p in "$1/private/weft-config" "$1/private/ssh-key" "$2/.ssh/id_ed25519" "$2/.config/weft/config.json"; do
    if cat "$p" >/dev/null 2>&1; then echo "FAIL: read succeeded: $p"; exit 1; fi
  done
  echo "PASS: protected reads denied"
' sh "$RUN_DIR" "$HOME"

echo 'Check: model provider domain is reachable'
"$SRT" --settings "$SETTINGS" -- curl -sS --max-time 12 -o /dev/null -w 'api.openai.com HTTP %{http_code}\n' https://api.openai.com/
echo 'Check: allowed git HTTPS domain is reachable'
"$SRT" --settings "$SETTINGS" -- git clone --quiet --depth 1 https://github.com/octocat/Hello-World.git "$RUN_DIR/git-https"
echo 'PASS: HTTPS clone completed'
echo 'Check: SSH Git clone (requires an allowed usable SSH credential)'
if GIT_TERMINAL_PROMPT=0 timeout 15 "$SRT" --settings "$SETTINGS" -- git clone --quiet --depth 1 git@github.com:octocat/Hello-World.git "$RUN_DIR/git-ssh" 2>/dev/null; then
  echo 'PASS: SSH clone completed'
else
  echo 'UNAVAILABLE: SSH clone failed (credential/proxy dependent)'
fi
echo 'Check: package installation (npm registry must be allowed)'
if timeout 20 "$SRT" --settings "$SETTINGS" -- npm install --prefix "$RUN_DIR/npm-probe" --package-lock=false --ignore-scripts left-pad 2>/dev/null; then
  echo 'PASS: npm package install completed'
else
  echo 'DENIED: npm package install needs registry.npmjs.org and applicable redirect hosts allowlisted'
fi
echo 'Check: non-allowlisted domain is denied'
if "$SRT" --settings "$SETTINGS" -- curl -sS --max-time 8 -o /dev/null https://example.org/; then
  echo 'FAIL: non-allowlisted domain was reachable' >&2; exit 1
else
  echo 'PASS: example.org denied'
fi

echo 'Check: Weft callback endpoint'
if [[ -n "${WEFT_TEST_URL:-}" ]]; then
  echo "Testing explicitly supplied Weft endpoint: $WEFT_TEST_URL"
  "$SRT" --settings "$SETTINGS" -- env -u no_proxy -u NO_PROXY curl -sS --max-time 12 -o /dev/null -w 'Weft callback HTTP %{http_code}\n' -H 'Authorization: Bearer prototype-invalid-token' -H 'x-weft-source: cli' "$WEFT_TEST_URL"
else
  echo 'SKIP: set WEFT_TEST_URL to a reachable Weft API endpoint; Linux SRT isolates host loopback.'
fi
