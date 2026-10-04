#!/usr/bin/env bash
# Runs the app on one Firebase Test Lab device and prints what happened.
#
# The default, instrumentation, runs the tests in android/app/src/androidTest:
#   ShareAndBackgroundTest  share a video in and convert it, then convert
#                           again with the app sent to the background
#                           mid-encode, both on hardware WebCodecs (which the
#                           emulator lacks, so it falls back to ffmpeg.wasm)
#   ShareSourcesTest        share from the media store, from a provider that
#                           acts like Google Photos, and from Google Photos
#                           itself where installed (the emulator test can
#                           only share from the app's own files)
# robo instead lets Test Lab's crawler poke at the app for a while; it can't
# see much past Chrome opening, so it mostly shows the app launches.
#
# The app loads the live site (dubsector.github.io), not this branch's web
# build: there is no way to serve one to a Test Lab device.
#
# Usage: android/test-lab/run-firebase-test.sh [instrumentation|robo]
# Build first: (cd android && ./gradlew assembleDebug assembleDebugAndroidTest)
# Needs gcloud signed in to the Firebase project, and ffmpeg for the test
# video. Settings, from the environment:
#   DEVICE_MODEL, OS_VERSION  the device (default: oriole, a Pixel 6, on 33).
#                             `gcloud firebase test android models list` has
#                             the choices; the free plan allows a few runs a
#                             day on each of physical and virtual devices.
#   ENGINE                    what each conversion must have used: hardware
#                             (WebCodecs on a hardware encoder, the default),
#                             webcodecs (software encoder too) or any
#   TESTS                     all (default), convert (ShareAndBackgroundTest)
#                             or share (ShareSourcesTest)
#   TIMEOUT                   longest the run may take (default 15m)
#   OUT_DIR                   where results are downloaded (test-lab-output)
set -euo pipefail

TYPE=${1:-instrumentation}
HERE=$(cd "$(dirname "$0")" && pwd)
APK_DIR="$HERE/../app/build/outputs/apk"
APP_APK="$APK_DIR/debug/app-debug.apk"
TEST_APK="$APK_DIR/androidTest/debug/app-debug-androidTest.apk"
DEVICE_MODEL=${DEVICE_MODEL:-oriole}
OS_VERSION=${OS_VERSION:-33}
TIMEOUT=${TIMEOUT:-15m}
OUT_DIR=${OUT_DIR:-test-lab-output}
RESULTS_DIR=${RESULTS_DIR:-run-$(date -u +%Y%m%d-%H%M%S)}

mkdir -p "$OUT_DIR"
[ -f "$APP_APK" ] || { echo "No $APP_APK; run ./gradlew assembleDebug in android/ first" >&2; exit 1; }

echo "Device: $DEVICE_MODEL, Android API $OS_VERSION"
# Fails early, with the reason, if the device isn't offered.
form=$(gcloud firebase test android models describe "$DEVICE_MODEL" --format='value(form)')
echo "Form: $form"
# Virtual devices have no hardware video encoder, so the app falls back to
# ffmpeg.wasm there, which the test fails on (see ENGINE below).
if [ "$TYPE" = instrumentation ] && [ "${TESTS:-all}" != share ] && [ "$form" != PHYSICAL ] && [ "${ENGINE:-hardware}" != any ]; then
  echo "$DEVICE_MODEL is a $form device, with no hardware encoder; pick a physical one, or set ENGINE=any" >&2
  exit 2
fi

args=(--app "$APP_APK"
  --device "model=$DEVICE_MODEL,version=$OS_VERSION,locale=en,orientation=portrait"
  --timeout "$TIMEOUT"
  --results-history-name video-shrinker
  --results-dir "$RESULTS_DIR")

case "$TYPE" in
  instrumentation)
    [ -f "$TEST_APK" ] || { echo "No $TEST_APK; run ./gradlew assembleDebugAndroidTest in android/ first" >&2; exit 1; }
    # The same noisy 12-second 720p clip the emulator test converts.
    ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" \
      -vf "noise=alls=25:allf=t" -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 8M -maxrate 8M -bufsize 8M \
      "$OUT_DIR/smoke-test.mp4"
    # Chrome reads this once the test makes it the debug app: skip its
    # first-run screens and the Digital Asset Links check, which the debug
    # signing key would fail (leaving a Custom Tab with a URL bar).
    echo "_ --disable-fre --no-default-browser-check --no-first-run --disable-digital-asset-link-verification-for-url=https://dubsector.github.io" \
      > "$OUT_DIR/chrome-command-line"
    args+=(--type instrumentation --test "$TEST_APK"
      --environment-variables "engine=${ENGINE:-hardware}"
      --other-files "/data/local/tmp/smoke-test.mp4=$OUT_DIR/smoke-test.mp4,/data/local/tmp/chrome-command-line=$OUT_DIR/chrome-command-line"
      --directories-to-pull /sdcard/test-lab)
    case "${TESTS:-all}" in
      all) ;;
      convert) args+=(--test-targets "class io.github.dubsector.videoshrinker.ShareAndBackgroundTest") ;;
      share) args+=(--test-targets "class io.github.dubsector.videoshrinker.ShareSourcesTest") ;;
      *) echo "TESTS must be all, convert or share" >&2; exit 2 ;;
    esac
    ;;
  robo)
    args+=(--type robo)
    ;;
  *)
    echo "usage: run-firebase-test.sh [instrumentation|robo]" >&2
    exit 2
    ;;
esac

status=0
gcloud firebase test android run "${args[@]}" 2>&1 | tee "$OUT_DIR/gcloud.log" || status=${PIPESTATUS[0]}

# gcloud names the bucket it stored the results in as a console link.
bucket=$(grep -oE 'storage/browser/[^/]+' "$OUT_DIR/gcloud.log" | head -1 | cut -d/ -f3 || true)
report=$(grep -oE 'https://console\.firebase\.google\.com/[^] ]+' "$OUT_DIR/gcloud.log" | head -1 || true)
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Firebase Test Lab ($TYPE)"
    echo "- Device: $DEVICE_MODEL, Android API $OS_VERSION"
    echo "- Result: $([ "$status" -eq 0 ] && echo passed || echo "failed (gcloud exit code $status)")"
    [ -z "$report" ] || echo "- [Full report, with video, in the Firebase console]($report)"
  } >> "$GITHUB_STEP_SUMMARY"
fi

if [ -n "$bucket" ]; then
  # Print what the test logged, so the job log alone is enough to debug.
  gcloud storage cp --recursive "gs://$bucket/$RESULTS_DIR" "$OUT_DIR/" > /dev/null 2>&1 \
    || echo "Could not download the results from gs://$bucket/$RESULTS_DIR"
  echo
  echo "--- What the test saw:"
  find "$OUT_DIR" -name logcat -exec grep -h 'TestLabSmoke' {} + 2> /dev/null || true
  echo "--- Crashes:"
  find "$OUT_DIR" -name logcat -exec grep -hE 'FATAL EXCEPTION|AndroidRuntime: Process: ' -A3 {} + 2> /dev/null | head -30 || true
fi
exit "$status"
