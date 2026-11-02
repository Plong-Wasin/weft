#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

for command in docker curl jq python3; do
  command -v "$command" >/dev/null || { echo "Required command not found: $command" >&2; exit 1; }
done

token="$(python3 -c 'import secrets; print(secrets.token_hex(5))')"
compose_project="weft-smoke-${token}"
tmp_dir="$(mktemp -d)"
compose=(docker compose --project-name "$compose_project" --env-file "$tmp_dir/compose.env" -f compose.yaml -f compose.proxy.yaml)
events_pid=""

free_port() {
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  echo "Cleaning smoke project $compose_project..."
  if [[ -n "$events_pid" ]]; then
    kill "$events_pid" 2>/dev/null || true
    wait "$events_pid" 2>/dev/null || true
  fi
  "${compose[@]}" down --volumes --remove-orphans || status=1
  rm -rf "$tmp_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

cat > "$tmp_dir/compose.env" <<EOF_ENV
BETTER_AUTH_SECRET=$(python3 -c 'import secrets; print(secrets.token_hex(32))')
POSTGRES_PASSWORD=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
S3_SECRET_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
POSTGRES_PORT=$(free_port)
MINIO_PORT=$(free_port)
MINIO_CONSOLE_PORT=$(free_port)
API_PORT=$(free_port)
MCP_PORT=$(free_port)
WEB_PORT=$(free_port)
CADDY_HTTP_PORT=$(free_port)
CADDY_HTTPS_PORT=$(free_port)
POSTGRES_CONTAINER=${compose_project}-postgres
MINIO_CONTAINER=${compose_project}-minio
SITE_ADDRESS=localhost
EOF_ENV

# Probe the default HTTPS origin while routing the socket to an available host port.
site_port="$(free_port)"
sed -i "s/^CADDY_HTTPS_PORT=.*/CADDY_HTTPS_PORT=$site_port/" "$tmp_dir/compose.env"
public_url="https://localhost"
printf 'WEFT_PUBLIC_URL=%s\n' "$public_url" >> "$tmp_dir/compose.env"

proxy_port="$(sed -n 's/^CADDY_HTTP_PORT=//p' "$tmp_dir/compose.env")"
"${compose[@]}" up --detach --build

request() {
  local response status
  if response="$(curl --silent --show-error --fail-with-body --insecure --connect-to "localhost:443:localhost:$site_port" --max-time "${CURL_TIMEOUT:-20}" "$@")"; then
    printf '%s' "$response"
  else
    status=$?
    printf 'Request failed (curl exit %s): %s\n%s\n' "$status" "$*" "$response" >&2
    return "$status"
  fi
}

wait_for_proxy() {
  local attempt
  for attempt in $(seq 1 120); do
    if curl --silent --insecure --connect-to "localhost:443:localhost:$site_port" --max-time 2 "$public_url/" >/dev/null; then return 0; fi
    sleep 2
  done
  echo "Caddy did not become ready at $public_url (HTTP listener port $proxy_port)" >&2
  return 1
}

wait_for_proxy

email="smoke-${token}@example.test"
password="Smoke-${token}-password"
jar="$tmp_dir/cookies.txt"
request --cookie-jar "$jar" --header "origin: $public_url" --header 'content-type: application/json' \
  --data "$(jq -n --arg name 'Proxy Smoke' --arg email "$email" --arg password "$password" '{name:$name,email:$email,password:$password}')" \
  "$public_url/api/auth/sign-up/email" >/dev/null
# Sign-in is a distinct public route and confirms the cookie round trip through Caddy.
request --cookie-jar "$jar" --cookie "$jar" --header "origin: $public_url" --header 'content-type: application/json' \
  --data "$(jq -n --arg email "$email" --arg password "$password" '{email:$email,password:$password}')" \
  "$public_url/api/auth/sign-in/email" >/dev/null

action() {
  local name=$1 body=$2
  request --cookie "$jar" --header "origin: $public_url" --header 'content-type: application/json' --data "$body" "$public_url/actions/$name"
}

workspace="$(action create_workspace "$(jq -n --arg name 'Proxy Smoke' --arg slug "smoke-${token}" '{name:$name,slug:$slug}')")"
workspace_id="$(jq -r '.id' <<<"$workspace")"
project_result="$(action create_project "$(jq -n --arg id "$workspace_id" '{workspaceId:$id,name:"Smoke project",key:"SMOKE",visibility:"public"}')")"
project_id="$(jq -r '.id' <<<"$project_result")"
[[ -n "$project_id" && "$project_id" != null ]] || { echo "create_project returned no project id" >&2; exit 1; }

events="$tmp_dir/events.txt"
CURL_TIMEOUT=60 curl --silent --show-error --insecure --connect-to "localhost:443:localhost:$site_port" --no-buffer --max-time 60 --cookie "$jar" "$public_url/api/events" >"$events" 2>"$tmp_dir/events.err" &
events_pid=$!
for _ in $(seq 1 50); do
  if grep -q ': connected' "$events" 2>/dev/null; then break; fi
  sleep 0.2
done
wiki="$(action create_wiki_page "$(jq -n --arg id "$workspace_id" '{workspaceId:$id,title:"Proxy smoke asset owner"}')")"
wiki_id="$(jq -r '.id' <<<"$wiki")"
for _ in $(seq 1 50); do
  if grep -q 'event: change' "$events" 2>/dev/null; then break; fi
  sleep 0.2
done
kill "$events_pid" 2>/dev/null || true
wait "$events_pid" 2>/dev/null || true
grep -q 'event: change' "$events" || { echo "SSE did not deliver a change event through the proxy" >&2; cat "$tmp_dir/events.err" >&2; exit 1; }

image="$tmp_dir/pixel.png"
printf '\211PNG\r\n\032\n\000\000\000\rIHDR\000\000\000\001\000\000\000\001\010\006\000\000\000\037\025\304\211\000\000\000\013IDAT\010\327c\370\317\300\000\000\003\001\001\000\311\376\222\357\000\000\000\000IEND\256B\140\202' > "$image"
upload="$(action request_asset_upload "$(jq -n --arg id "$wiki_id" --arg filename 'pixel.png' --argjson size "$(wc -c < "$image")" '{ownerType:"wiki_page",ownerId:$id,filename:$filename,contentType:"image/png",size:$size}')")"
asset_id="$(jq -r '.assetId' <<<"$upload")"
upload_url="$(jq -r '.url' <<<"$upload")"
fields="$(jq -r '.fields | to_entries[] | @base64' <<<"$upload")"
form_args=()
while IFS= read -r field; do
  entry="$(base64 --decode <<<"$field")"
  key="$(jq -r '.key' <<<"$entry")"
  value="$(jq -r '.value' <<<"$entry")"
  form_args+=(--form-string "$key=$value")
done <<<"$fields"
request --max-time 30 "${form_args[@]}" --form "file=@$image;type=image/png" "$upload_url" >/dev/null
action complete_asset_upload "$(jq -n --arg id "$asset_id" '{assetId:$id}')" >/dev/null
download="$(action get_asset_download_url "$(jq -n --arg id "$asset_id" '{assetId:$id}')")"
download_url="$(jq -r '.url' <<<"$download")"
request --max-time 30 "$download_url" --output "$tmp_dir/download.png"
cmp "$image" "$tmp_dir/download.png"

metadata="$(request "$public_url/.well-known/oauth-protected-resource")"
jq -e --arg resource "$public_url/mcp" '.resource == $resource' <<<"$metadata" >/dev/null || { echo "Unexpected MCP protected-resource metadata" >&2; exit 1; }

printf 'Proxy smoke passed: login, create_project action, SSE change, asset upload/download, MCP metadata.\n'
printf 'Manual browser checks still needed: installed PWA OAuth navigation, editor image paste, and OAuth authorize/consent flow.\n'
