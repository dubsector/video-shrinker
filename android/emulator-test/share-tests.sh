#!/usr/bin/env bash
# Runs the share tests from android/app/src/androidTest (ShareSourcesTest:
# shares from the media store, from a provider that acts like Google Photos,
# with the video only in ClipData, with a photo ahead of the video, and from
# Google Photos itself where its screens can be got through) on a running
# emulator. These are the share tests Firebase Test Lab runs on a real
# phone, without using its daily quota. No conversion is checked, so the
# emulator's lack of a hardware encoder doesn't matter.
#
# With WEB_ROOT set to a web build (dist/), the app loads that build
# instead of the live site, so a PR's shares are tested against its own web
# app. A test that fails is run once more by itself before the run counts
# as failed: a freshly booted emulator is sometimes too slow to show the app
# in time, a different test each run.
#
# Usage: android/emulator-test/share-tests.sh
# Run from the repository root with an emulator attached. Needs adb and
# ffmpeg, and openssl and Node 22+ with WEB_ROOT. Screenshots, logcat and
# the test report go to $OUT_DIR (default: emulator-test-output/share-tests).
set -euo pipefail

OUT_DIR=${OUT_DIR:-emulator-test-output/share-tests}
HERE=$(cd "$(dirname "$0")" && pwd)
TESTS=io.github.dubsector.videoshrinker.ShareSourcesTest
mkdir -p "$OUT_DIR"
# shellcheck source=android/emulator-test/local-site.sh
. "$HERE/local-site.sh"
trap 'kill $(jobs -p) 2>/dev/null || true' EXIT

# The same noisy 12-second 720p clip as run-firebase-test.sh, where
# WebApp.VIDEO expects it.
ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
  -vf "noise=alls=25:allf=t" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 8M \
  "$OUT_DIR/smoke-test.mp4"
adb push "$OUT_DIR/smoke-test.mp4" /data/local/tmp/smoke-test.mp4 > /dev/null
rm "$OUT_DIR/smoke-test.mp4"
# Updates to Chrome from the Play Store would kill it mid-test.
adb shell pm disable-user --user 0 com.android.vending > /dev/null || true
# A slow first boot can leave "Pixel Launcher isn't responding" on top of
# every test's screen. Don't show such dialogs.
adb shell settings put global hide_error_dialogs 1 || true
# A current Chrome in place of the image's own, where the workflow got one
# (CHROME_APKS: see android-emulator.yml).
if [ -n "${CHROME_APKS:-}" ]; then
  adb install-multiple -r "$CHROME_APKS"/*.apk > /dev/null
fi

# Chrome's flags, as on Test Lab: skip its first-run screens and the Digital
# Asset Links check, which the debug signing key would fail.
flags=(_ --disable-fre --no-default-browser-check --no-first-run
  --disable-digital-asset-link-verification-for-url=https://dubsector.github.io)
if [ -n "${WEB_ROOT:-}" ]; then
  serve_web_root "$WEB_ROOT" "$OUT_DIR"
  flags+=("${LOCAL_SITE_FLAGS[@]}")
else
  echo "Using the live site"
fi
echo "${flags[*]}" | adb shell 'cat > /data/local/tmp/chrome-command-line'
adb shell rm -rf /sdcard/test-lab
# Room for the whole run's logcat, read back at the end.
adb logcat -G 16M || true
adb logcat -c || true

# Runs the tests named in $2 (a class, or class#test,class#test), giving up
# after $1.
run_tests() {
  (cd android && timeout --signal=INT --kill-after=30s "$1" ./gradlew connectedDebugAndroidTest \
    "-Pandroid.testInstrumentationRunnerArguments.class=$2" \
    -Pandroid.testInstrumentationRunnerArguments.engine=any)
}

status=0
# Each test has its own time limit, but stop the whole run in time to save
# the logs below before the CI step's time runs out.
run_tests 17m "$TESTS" || status=$?
# 124 is the time limit: a run that hung is not worth starting again.
if [ "$status" != 0 ] && [ "$status" != 124 ]; then
  failed=$(timeout 60s adb logcat -d 2> /dev/null | grep -oE 'TestRunner: failed: [A-Za-z0-9_]+' | awk '{print $3}' | sort -u)
  if [ -n "$failed" ]; then
    echo "--- Failed the first time, running once more: $(echo $failed)"
    # The second run's report replaces the first's; keep both.
    cp -r android/app/build/outputs/androidTest-results "$OUT_DIR/first-run-results" 2> /dev/null || true
    timeout 60s adb pull /sdcard/test-lab "$OUT_DIR/first-run-screens" > /dev/null 2>&1 || true
    status=0
    run_tests 6m "$(for t in $failed; do printf '%s#%s,' "$TESTS" "$t"; done | sed 's/,$//')" || status=$?
    [ "$status" = 0 ] && echo "--- Passed the second time: $(echo $failed)"
  fi
fi

# adb waits forever for an emulator that crashed during the run.
timeout 60s adb pull /sdcard/test-lab "$OUT_DIR/" > /dev/null 2>&1 || true
timeout 60s adb logcat -d > "$OUT_DIR/logcat.txt" 2> /dev/null || true
cp -r android/app/build/outputs/androidTest-results android/app/build/reports/androidTests "$OUT_DIR/" 2> /dev/null || true
# The emulator sometimes dies mid-run with nothing in its own output. Show
# whether it is still running and whether the runner's kernel killed it
# (out of memory) or it crashed.
if ! timeout 10s adb get-state > /dev/null 2>&1; then
  echo "--- The emulator stopped answering. What the runner saw:"
  pgrep -a qemu || echo "no emulator process left"
  free -m || true
  sudo dmesg 2> /dev/null | grep -iE 'out of memory|killed process|oom|qemu|segfault|general protection' | tail -20 || true
  ls -la /tmp/android-runner 2> /dev/null || true
fi
echo "--- What the tests saw:"
grep -E 'TestLabSmoke' "$OUT_DIR/logcat.txt" | sed -E 's/^.*TestLabSmoke[^:]*: //' | tail -80 || true
if [ "$status" != 0 ]; then
  # Enough of the system's side to follow a lost share from the job log:
  # what happened while each failed test ran.
  for test in $(grep -oE 'TestRunner: failed: [A-Za-z0-9_]+' "$OUT_DIR/logcat.txt" | awk '{print $3}' | sort -u); do
    echo "--- Logcat during $test:"
    awk -v t="$test(" 'index($0, "TestRunner: started: " t) {on = 1} on; index($0, "TestRunner: finished: " t) {on = 0}' "$OUT_DIR/logcat.txt" \
      | grep -E 'ActivityTaskManager: (START|Activity start|Displayed)|ActivityManager: (Start proc|Killing|Process .* has died)|ShareRelay|LauncherActivity|TwaLauncher|androidbrowserhelper|AndroidRuntime|Permission Denial|SecurityException|BAL_|io\.github\.dubsector\.videoshrinker|cr_.*(Share|Intent|TWA|Trusted|Customtabs)|TestLabSmoke' \
      | cut -c1-400 | tail -120 || true
  done
  # A run that hung shows no failed test, only the time limit. Show what
  # happened after the last test that finished, to find where it stopped.
  echo "--- Logcat after the last finished test:"
  awk '/TestRunner: finished: /{n = NR} {line[NR] = $0} END {for (i = n + 1; i <= NR; i++) print line[i]}' "$OUT_DIR/logcat.txt" \
    | grep -E 'TestRunner|MonitoringInstr|ActivityFinisher|InstrumentationResultPrinter|ActivityTaskManager: (START|Activity start|Displayed)|ActivityManager: (Start proc|Killing|Process .* has died|ANR)|AndroidRuntime|TestLabSmoke|io\.github\.dubsector\.videoshrinker' \
    | cut -c1-400 | tail -150 || true
fi
exit $status
