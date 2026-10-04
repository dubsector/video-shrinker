#!/usr/bin/env bash
# Smoke-tests the debug APK on a running emulator (or a USB device):
#   1. launches the app and checks Chrome opens the web app,
#   2. shares a video to it through a content URI, and checks the relay
#      copied it and the web app received it,
#   3. converts that video and sends the app to the background mid-encode,
#      then checks the conversion still finishes.
#
# Usage: android/emulator-test/smoke-test.sh path/to/app-debug.apk
# Needs adb, ffmpeg and Node 22+ on PATH. Screenshots, logcat and the page
# driver's log are written to $OUT_DIR (default: emulator-test-output).
set -euo pipefail

APK=${1:?usage: smoke-test.sh path/to/app-debug.apk}
OUT_DIR=${OUT_DIR:-emulator-test-output}
PKG=io.github.dubsector.videoshrinker
CHROME=com.android.chrome
APP_URL=https://dubsector.github.io/video-shrinker/
HERE=$(cd "$(dirname "$0")" && pwd)
VIDEO=smoke-test.mp4

mkdir -p "$OUT_DIR"

step() { echo; echo "=== $*"; }
shot() { adb exec-out screencap -p > "$OUT_DIR/$1.png" || true; }
fail() {
  echo "FAIL: $*" >&2
  shot failure
  adb logcat -d > "$OUT_DIR/logcat.txt" || true
  # Print the likely-relevant bits too, so the job log alone is enough to debug.
  echo "--- On screen:"
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 \
    && adb shell cat /sdcard/ui.xml | grep -oE 'text="[^"]+"' | head -40 || true
  echo "--- Logcat:"
  grep -iE "$PKG|ShareRelay|AndroidRuntime|Permission Denial|SecurityException|ActivityTaskManager: START" \
    "$OUT_DIR/logcat.txt" | tail -60 || true
  exit 1
}
trap 'adb logcat -d > "$OUT_DIR/logcat.txt" 2>/dev/null || true' EXIT

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
chrome_path=$(adb shell pm path "$CHROME" | tr -d '\r')
[ -n "$chrome_path" ] || fail "Chrome is not installed; use a google_apis_playstore image"
echo "Chrome $(adb shell dumpsys package "$CHROME" | grep -m1 versionName | tr -d '\r ')"
# Chrome only reads this command-line file when it is the debug app. The
# debug APK is signed with a key the site's assetlinks.json doesn't list, so
# skip the Digital Asset Links check to get a real verified TWA, and skip
# Chrome's first-run screens.
adb shell am set-debug-app --persistent "$CHROME"
adb shell "echo '_ --disable-fre --no-default-browser-check --no-first-run --disable-digital-asset-link-verification-for-url=https://dubsector.github.io' > /data/local/tmp/chrome-command-line"
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

step "Sharing a video to the app"
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -vf "noise=alls=25:allf=t" -c:v libx264 -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 8M \
  "$OUT_DIR/$VIDEO"
size=$(stat -c %s "$OUT_DIR/$VIDEO")
echo "Test video: $size bytes"
# The shell can't grant another app access to a MediaStore item, so serve
# the video from the app's own FileProvider instead. The relay still reads
# it through a content URI and copies it, as it would from the gallery.
adb push "$OUT_DIR/$VIDEO" "/data/local/tmp/$VIDEO" > /dev/null
adb shell "cat /data/local/tmp/$VIDEO | run-as $PKG sh -c 'mkdir -p files/twa_splash && cat > files/twa_splash/$VIDEO'"
uri="content://$PKG.fileprovider/twa_splash/$VIDEO"
echo "Sharing $uri"
# Go home first so the share arrives like it would from the gallery.
adb shell input keyevent KEYCODE_HOME
adb shell am start -a android.intent.action.SEND -t video/mp4 \
  --eu android.intent.extra.STREAM "$uri" \
  -n "$PKG/.ShareRelayActivity"
relay_copied() {
  local copied
  copied=$(adb shell run-as "$PKG" stat -c %s "cache/shared_videos/$VIDEO" 2>/dev/null | tr -d '\r')
  [ "$copied" = "$size" ]
}
wait_for 60 relay_copied || {
  adb shell run-as "$PKG" ls -la cache cache/shared_videos || true
  fail "the share relay did not copy the video into the app's cache"
}
echo "Relay copied $size bytes"
wait_for 60 chrome_in_front || fail "Chrome never came to the front after the share"
app_crashed && fail "the app crashed handling the share"
node "$HERE/page.mjs" shared "$VIDEO" | tee -a "$OUT_DIR/page.log" || fail "the web app never received the shared video"
shot 2-shared

step "Converting, with the app sent to the background mid-encode"
node "$HERE/page.mjs" convert | tee -a "$OUT_DIR/page.log" || fail "the conversion did not start"
shot 3-converting
adb shell input keyevent KEYCODE_HOME
sleep 20
shot 4-background
node "$HERE/page.mjs" progress | tee -a "$OUT_DIR/page.log" || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 > /dev/null
wait_for 30 chrome_in_front || fail "the app did not come back to the front"
node "$HERE/page.mjs" finished | tee -a "$OUT_DIR/page.log" || fail "the conversion did not finish after backgrounding"
app_crashed && fail "the app crashed during the conversion"
shot 5-done

echo
echo "PASS"
