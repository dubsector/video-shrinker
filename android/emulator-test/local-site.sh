# Sourced by smoke-test.sh and share-tests.sh.
#
# serve_web_root DIR OUT_DIR
# Serves DIR (a `npm run build` output) in place of the live site: Chrome
# resolves dubsector.github.io to a local HTTPS server reached over adb
# reverse, and trusts its throwaway certificate by key. Sets
# LOCAL_SITE_FLAGS to the Chrome flags that do this, for the caller to add
# to /data/local/tmp/chrome-command-line. The server runs in the background
# of the calling script and logs to OUT_DIR/server.log.
serve_web_root() {
  local root=$1 out=$2 here spki
  here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  [ -f "$root/index.html" ] || { echo "No web build in $root; run npm run build first" >&2; return 1; }
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=dubsector.github.io \
    -keyout "$out/key.pem" -out "$out/cert.pem" 2> /dev/null
  spki=$(openssl x509 -in "$out/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der \
    | openssl dgst -sha256 -binary | base64)
  node "$here/serve.mjs" "$root" "$out/cert.pem" "$out/key.pem" 4443 > "$out/server.log" 2>&1 &
  adb reverse tcp:4443 tcp:4443
  LOCAL_SITE_FLAGS=("\"--host-resolver-rules=MAP dubsector.github.io 127.0.0.1:4443\""
    "--ignore-certificate-errors-spki-list=$spki")
  echo "Serving $root as https://dubsector.github.io"
}
