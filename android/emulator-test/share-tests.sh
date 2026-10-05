#!/usr/bin/env bash
# Runs the share tests from android/app/src/androidTest (ShareSourcesTest:
# shares from the media store, from a provider that acts like Google Photos,
# with the video only in ClipData, with a photo ahead of the video, and from
# Google Photos itself where its screens can be got through) on a running
# emulator. These are the share tests Firebase Test Lab runs on a real
# phone, without using its daily quota. No conversion is checked, so the
# emulator's lack of a hardware encoder doesn't matter.
#
# The app loads the live site, as on Test Lab.
#
# Usage: android/emulator-test/share-tests.sh
# Run from the repository root with an emulator attached. Needs adb and
# ffmpeg. With CHROME_APK set to a Chromium build's ChromePublic.apk, the
# tests run in that instead of the emulator image's own Chrome, which is
# too old to have Chrome 153's share check; the image's Chrome is turned
# off so the app opens in Chromium. Screenshots, logcat and the test report go to $OUT_DIR (default:
# emulator-test-output/share-tests).
set -euo pipefail

OUT_DIR=${OUT_DIR:-emulator-test-output/share-tests}
mkdir -p "$OUT_DIR"

# The same noisy 12-second 720p clip as run-firebase-test.sh, where
# WebApp.VIDEO expects it.
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -vf "noise=alls=25:allf=t" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 8M \
  "$OUT_DIR/smoke-test.mp4"
adb push "$OUT_DIR/smoke-test.mp4" /data/local/tmp/smoke-test.mp4 > /dev/null
rm "$OUT_DIR/smoke-test.mp4"
# And one the size of a phone's longer clips: 150 seconds at 8 Mbit/s.
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=150" \
  -vf "noise=alls=25:allf=t" \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 8M \
  "$OUT_DIR/big-video.mp4"
adb push "$OUT_DIR/big-video.mp4" /data/local/tmp/big-video.mp4 > /dev/null
rm "$OUT_DIR/big-video.mp4"
# Chrome's flags, as on Test Lab: skip its first-run screens and the Digital
# Asset Links check, which the debug signing key would fail.
echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-digital-asset-link-verification-for-url=https://dubsector.github.io" \
  | adb shell 'cat > /data/local/tmp/chrome-command-line'
adb shell rm -rf /sdcard/test-lab
# Room for the whole run's logcat, read back at the end.
adb logcat -G 16M || true
adb logcat -c || true

chrome=com.android.chrome
if [ -n "${CHROME_APK:-}" ]; then
  echo "ABIs: $(adb shell getprop ro.product.cpu.abilist | tr -d '\r')"
  adb install -r -g "$CHROME_APK" > /dev/null
  adb shell pm disable-user --user 0 com.android.chrome > /dev/null
  chrome=$(adb shell pm list packages org.chromium.chrome | head -1 | tr -d '\r' | sed 's/^package://')
  echo "Testing in $chrome $(adb shell dumpsys package "$chrome" | grep -m1 versionName | tr -d '\r ')"
fi

status=0
(cd android && ./gradlew connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.chrome="$chrome" \
  -Pandroid.testInstrumentationRunnerArguments.class=io.github.dubsector.videoshrinker.ShareSourcesTest \
  -Pandroid.testInstrumentationRunnerArguments.engine=any) || status=$?

adb pull /sdcard/test-lab "$OUT_DIR/" > /dev/null 2>&1 || true
adb logcat -d > "$OUT_DIR/logcat.txt" 2> /dev/null || true
cp -r android/app/build/outputs/androidTest-results android/app/build/reports/androidTests "$OUT_DIR/" 2> /dev/null || true
echo "--- What the tests saw:"
grep -E 'TestLabSmoke' "$OUT_DIR/logcat.txt" | sed -E 's/^.*TestLabSmoke[^:]*: //' | tail -80 || true
if [ "$status" != 0 ]; then
  # Enough of the system's side to follow a lost share from the job log:
  # what happened while each failed test ran.
  for test in $(grep -oE 'TestRunner: failed: [A-Za-z]+' "$OUT_DIR/logcat.txt" | awk '{print $3}' | sort -u); do
    echo "--- Logcat during $test:"
    awk -v t="$test(" 'index($0, "TestRunner: started: " t) {on = 1} on; index($0, "TestRunner: finished: " t) {on = 0}' "$OUT_DIR/logcat.txt" \
      | grep -E 'ActivityTaskManager: (START|Activity start|Displayed)|ActivityManager: (Start proc|Killing|Process .* has died)|ShareRelay|LauncherActivity|TwaLauncher|androidbrowserhelper|AndroidRuntime|Permission Denial|SecurityException|BAL_|io\.github\.dubsector\.videoshrinker|cr_.*(Share|Intent|TWA|Trusted|Customtabs)|TestLabSmoke' \
      | cut -c1-400 | tail -120 || true
  done
fi
exit $status
