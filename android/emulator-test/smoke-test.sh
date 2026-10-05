#!/usr/bin/env bash
# Smoke-tests the debug APK on a running emulator (or a USB device):
#   1. launches the app and checks Chrome opens the web app,
#   2. shares a video to it through a content URI, checks the relay copied
#      it and the web app received it, and converts it with the app kept in
#      front,
#   3. shares it again, converts it and sends the app to the background
#      mid-encode, then checks the conversion still finishes.
# Comparing the two conversions tells a problem with backgrounding apart
# from one with converting at all. What the page and its workers log goes to
# console.log, so a fallback to ffmpeg.wasm comes with its reason.
#
# Usage: android/emulator-test/smoke-test.sh path/to/app-debug.apk
# Needs adb, ffmpeg, openssl and Node 22+ on PATH. With WEB_ROOT set to a
# web build (dist/), the app loads that build instead of the live site.
# Screenshots, logcat and the page driver's log are written to $OUT_DIR
# (default: emulator-test-output).
set -euo pipefail

APK=${1:?usage: smoke-test.sh path/to/app-debug.apk}
OUT_DIR=${OUT_DIR:-emulator-test-output}
PKG=io.github.dubsector.videoshrinker
CHROME=com.android.chrome
APP_URL=https://dubsector.github.io/video-shrinker/
HERE=$(cd "$(dirname "$0")" && pwd)
VIDEO=smoke-test.mp4

mkdir -p "$OUT_DIR"

# A wedged device (say, Android restarting itself) can leave adb waiting
# forever. Nothing here takes anywhere near this long, so fail instead.
ADB=$(command -v adb)
adb() { timeout 120 "$ADB" "$@"; }

step() { echo; echo "=== $*"; }
shot() {
  adb exec-out screencap -p > "$OUT_DIR/$1.png" 2> /dev/null || true
  # A failed capture leaves its error message where the image should be.
  head -c 4 "$OUT_DIR/$1.png" | grep -q PNG || mv "$OUT_DIR/$1.png" "$OUT_DIR/$1.screencap-error.txt"
}
app_console() {
  echo "--- App console:"
  grep -vE '^\s*$' "$OUT_DIR/console.log" 2> /dev/null | tail -40 || true
}
fail() {
  echo "FAIL: $*" >&2
  shot failure
  app_console
  adb logcat -d > "$OUT_DIR/logcat.txt" || true
  # Print the likely-relevant bits too, so the job log alone is enough to debug.
  echo "--- On screen:"
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 \
    && adb shell cat /sdcard/ui.xml | grep -oE 'text="[^"]+"' | head -40 || true
  # Native crashes (tombstones) and Java crashes, system processes included.
  echo "--- Crashes:"
  grep -E ' F DEBUG   : (Cmdline|Abort message|signal |pid: )|FATAL EXCEPTION|AndroidRuntime: Process: ' "$OUT_DIR/logcat.txt" | head -30 || true
  echo "--- Logcat:"
  grep -iE "$PKG|$CHROME|ShareRelay|AndroidRuntime|lowmemorykiller|Killing|Permission Denial|SecurityException|ActivityTaskManager: START" \
    "$OUT_DIR/logcat.txt" | tail -60 || true
  exit 1
}
trap 'adb logcat -d > "$OUT_DIR/logcat.txt" 2>/dev/null || true; kill $(jobs -p) 2>/dev/null || true' EXIT

# Waits up to $1 seconds for the command in the remaining arguments to succeed.
wait_for() {
  local timeout=$1; shift
  local end=$((SECONDS + timeout))
  until "$@"; do
    [ "$SECONDS" -lt "$end" ] || return 1
    sleep 2
  done
}

chrome_in_front() {
  adb shell dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity' | grep -q "$CHROME"
}

app_crashed() {
  adb logcat -d -b crash | grep -q "Process: $PKG"
}

step "Preparing the device"
adb wait-for-device
# Soon after boot the Play Store starts updating Chrome, WebView and Play
# services, and installing any of them kills Chrome partway through the test.
# Nothing here needs the Play Store, so switch it off first.
adb shell pm disable-user --user 0 com.android.vending > /dev/null \
  || echo "Could not disable the Play Store; Chrome may be updated mid-test"
# A current Chrome in place of the image's own, where the workflow got one
# (CHROME_APKS: see android-emulator.yml).
if [ -n "${CHROME_APKS:-}" ]; then
  adb install-multiple -r "$CHROME_APKS"/*.apk > /dev/null
fi
chrome_path=$(adb shell pm path "$CHROME" | tr -d '\r')
[ -n "$chrome_path" ] || fail "Chrome is not installed; use a google_apis_playstore image"
echo "Chrome $(adb shell dumpsys package "$CHROME" | grep -m1 versionName | tr -d '\r ')"
# Chrome only reads its command-line file when it is the debug app. The
# debug APK is signed with a key the site's assetlinks.json doesn't list, so
# skip the Digital Asset Links check to get a real verified TWA, and skip
# Chrome's first-run screens.
flags=(_ --disable-fre --no-default-browser-check --no-first-run
  --disable-digital-asset-link-verification-for-url=https://dubsector.github.io)
if [ -n "${WEB_ROOT:-}" ]; then
  # Serve WEB_ROOT (a `npm run build` output) in place of the live site:
  # Chrome resolves dubsector.github.io to a local HTTPS server reached over
  # adb reverse, and trusts its throwaway certificate by key.
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=dubsector.github.io \
    -keyout "$OUT_DIR/key.pem" -out "$OUT_DIR/cert.pem" 2> /dev/null
  spki=$(openssl x509 -in "$OUT_DIR/cert.pem" -pubkey -noout | openssl pkey -pubin -outform der \
    | openssl dgst -sha256 -binary | base64)
  node "$HERE/serve.mjs" "$WEB_ROOT" "$OUT_DIR/cert.pem" "$OUT_DIR/key.pem" 4443 > "$OUT_DIR/server.log" 2>&1 &
  adb reverse tcp:4443 tcp:4443
  flags+=("\"--host-resolver-rules=MAP dubsector.github.io 127.0.0.1:4443\""
    "--ignore-certificate-errors-spki-list=$spki")
  echo "Serving $WEB_ROOT as https://dubsector.github.io"
else
  echo "Using the live site"
fi
echo "${flags[*]}" > "$OUT_DIR/chrome-command-line"
adb push "$OUT_DIR/chrome-command-line" /data/local/tmp/chrome-command-line > /dev/null
adb shell am set-debug-app --persistent "$CHROME"
adb shell am force-stop "$CHROME"
adb logcat -c
adb logcat -b crash -c || true

step "Installing $APK"
adb install -r -g "$APK"

step "Launching the app"
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null
wait_for 60 chrome_in_front || fail "Chrome never came to the front after launch"
app_crashed && fail "the app crashed on launch"
adb forward tcp:9222 localabstract:chrome_devtools_remote
node "$HERE/page.mjs" loaded | tee -a "$OUT_DIR/page.log" || fail "the web app did not load in Chrome"
shot 1-launched

# Everything the page and its workers log, for the rest of the test.
node "$HERE/page.mjs" console > "$OUT_DIR/console.log" 2>&1 &

ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -vf "noise=alls=25:allf=t" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 8M \
  "$OUT_DIR/$VIDEO"
size=$(stat -c %s "$OUT_DIR/$VIDEO")
echo "Test video: $size bytes"
adb push "$OUT_DIR/$VIDEO" "/data/local/tmp/$VIDEO" > /dev/null

relay_copied() {
  local copied
  copied=$(adb shell run-as "$PKG" stat -c %s "cache/shared_videos/$1" 2>/dev/null | tr -d '\r')
  [ "$copied" = "$size" ]
}

# Shares the test video to the app as $1 and waits for the web app to show
# it. Each share uses a new name, so it can't be mistaken for the video
# already on screen.
share() {
  local name=$1
  # The shell can't grant another app access to a MediaStore item, so serve
  # the video from the app's own FileProvider instead. The relay still reads
  # it through a content URI and copies it, as it would from the gallery.
  adb shell "cat /data/local/tmp/$VIDEO | run-as $PKG sh -c 'mkdir -p files/twa_splash && cat > files/twa_splash/$name'"
  local uri="content://$PKG.fileprovider/twa_splash/$name"
  echo "Sharing $uri"
  # Go home first so the share arrives like it would from the gallery.
  adb shell input keyevent KEYCODE_HOME
  adb shell am start -a android.intent.action.SEND -t video/mp4 \
    --eu android.intent.extra.STREAM "$uri" \
    -n "$PKG/.ShareRelayActivity"
  wait_for 60 relay_copied "$name" || {
    adb shell run-as "$PKG" ls -la cache cache/shared_videos || true
    fail "the share relay did not copy $name into the app's cache"
  }
  echo "Relay copied $size bytes"
  wait_for 60 chrome_in_front || fail "Chrome never came to the front after sharing $name"
  app_crashed && fail "the app crashed handling the share"
  node "$HERE/page.mjs" shared "$name" | tee -a "$OUT_DIR/page.log" || fail "the web app never received $name"
}

step "Sharing a video and converting it with the app kept in front"
share stay.mp4
shot 2-stay-shared
node "$HERE/page.mjs" convert | tee -a "$OUT_DIR/page.log" || fail "the conversion did not start"
shot 3-stay-converting
node "$HERE/page.mjs" finished | tee -a "$OUT_DIR/page.log" || fail "the conversion did not finish with the app in front"
app_crashed && fail "the app crashed during the conversion"
shot 4-stay-done

step "Sharing it again and converting it with the app sent to the background mid-encode"
share leave.mp4
shot 5-leave-shared
node "$HERE/page.mjs" convert | tee -a "$OUT_DIR/page.log" || fail "the conversion did not start"
shot 6-leave-converting
chrome_pid=$(adb shell pidof "$CHROME" | tr -d '\r')
adb shell input keyevent KEYCODE_HOME
sleep 20
shot 7-leave-background
node "$HERE/page.mjs" progress | tee -a "$OUT_DIR/page.log" || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null
wait_for 30 chrome_in_front || fail "the app did not come back to the front"
echo "Chrome pid before backgrounding: $chrome_pid, after: $(adb shell pidof "$CHROME" | tr -d '\r')"
node "$HERE/page.mjs" finished | tee -a "$OUT_DIR/page.log" || fail "the conversion did not finish after backgrounding"
app_crashed && fail "the app crashed during the conversion"
shot 8-leave-done

echo
echo "--- Results:"
grep -E '^\[page\] (browser|finished):' "$OUT_DIR/page.log" | sed -E 's/.*"(chrome|result)":"([^"]*)".*/\1: \2/'
app_console
echo
echo "PASS"
