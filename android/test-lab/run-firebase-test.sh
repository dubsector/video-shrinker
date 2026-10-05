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
#   UpdateDuringShareTest   share while a new version of the web app comes
#                           out: serves this branch's build (dist/, from
#                           npm run build) from the phone and releases a new
#                           version mid-test
# robo instead lets Test Lab's crawler poke at the app for a while; it can't
# see much past Chrome opening, so it mostly shows the app launches.
#
# The app loads the live site (dubsector.github.io), not this branch's web
# build, except in UpdateDuringShareTest, which serves dist/ from the phone.
#
# Usage: android/test-lab/run-firebase-test.sh [instrumentation|robo]
# Build first: (cd android && ./gradlew assembleDebug assembleDebugAndroidTest)
# Needs gcloud signed in to the Firebase project, and ffmpeg for the test
# video. Settings, from the environment:
#   DEVICE_MODEL, OS_VERSION  the device (default: grizzly, a Pixel 11 Pro, on 37).
#                             `gcloud firebase test android models list` has
#                             the choices; the free plan allows a few runs a
#                             day on each of physical and virtual devices.
#   VIRTUAL_FALLBACK          1 (default) to run again once on a virtual
#                             device when Test Lab refuses the physical one
#                             for lack of quota, with ENGINE relaxed to any
#                             (virtual devices have no hardware encoder); 0
#                             to just fail
#   VIRTUAL_DEVICE_MODEL      the virtual device for that (default
#                             MediumPhone.arm, or else the first virtual
#                             device offered), on OS_VERSION when it has it,
#                             else its newest
#   MIN_CHROME                the oldest Chrome major version the run counts as
#                             current (default 153); the summary warns when
#                             the device's Chrome is older
#   ENGINE                    what each conversion must have used: hardware
#                             (WebCodecs on a hardware encoder, the default),
#                             webcodecs (software encoder too) or any
#   TESTS                     all (default), convert (ShareAndBackgroundTest),
#                             share (ShareSourcesTest) or update
#                             (UpdateDuringShareTest)
#   TIMEOUT                   longest the run may take (default 15m)
#   OUT_DIR                   where results are downloaded (test-lab-output)
#   RESULTS_BUCKET            a bucket of your own for the results, instead of
#                             the one Test Lab creates (needs billing)
set -euo pipefail

TYPE=${1:-instrumentation}
HERE=$(cd "$(dirname "$0")" && pwd)
APK_DIR="$HERE/../app/build/outputs/apk"
APP_APK="$APK_DIR/debug/app-debug.apk"
TEST_APK="$APK_DIR/androidTest/debug/app-debug-androidTest.apk"
DEVICE_MODEL=${DEVICE_MODEL:-grizzly}
OS_VERSION=${OS_VERSION:-37}
MIN_CHROME=${MIN_CHROME:-153}
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
if [ "$TYPE" = instrumentation ] && [ "${TESTS:-all}" = all -o "${TESTS:-all}" = convert ] && [ "$form" != PHYSICAL ] && [ "${ENGINE:-hardware}" != any ]; then
  echo "$DEVICE_MODEL is a $form device, with no hardware encoder; pick a physical one, or set ENGINE=any" >&2
  exit 2
fi

args=(--app "$APP_APK"
  --timeout "$TIMEOUT"
  --results-history-name video-shrinker)
[ -z "${RESULTS_BUCKET:-}" ] || args+=(--results-bucket "$RESULTS_BUCKET")

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
    flags="_ --disable-fre --no-default-browser-check --no-first-run --disable-digital-asset-link-verification-for-url=https://dubsector.github.io"
    echo "$flags" > "$OUT_DIR/chrome-command-line"
    cp "$OUT_DIR/chrome-command-line" "$OUT_DIR/chrome-command-line-live"
    # UpdateDuringShareTest serves this branch's build from the phone, over
    # HTTPS on 127.0.0.1:8443, and switches Chrome to these flags: a host rule
    # sends dubsector.github.io there, and the throwaway certificate made here
    # is trusted by its key's hash.
    SITE_DIST="$HERE/../../dist"
    if [ -f "$SITE_DIST/index.html" ]; then
      rm -f "$OUT_DIR/site.zip"
      # Without the 32 MB ffmpeg fallback, which a phone with WebCodecs never loads.
      (cd "$SITE_DIST" && zip -qr - . -x 'ffmpeg-core/*') > "$OUT_DIR/site.zip"
    else
      echo "No dist/ to serve; UpdateDuringShareTest will fail. Run npm run build first." >&2
      : > "$OUT_DIR/site.zip"
    fi
    openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj "/CN=dubsector.github.io" \
      -addext "subjectAltName=DNS:dubsector.github.io" \
      -keyout "$OUT_DIR/site-key.pem" -out "$OUT_DIR/site-cert.pem" 2> /dev/null
    openssl pkcs12 -export -inkey "$OUT_DIR/site-key.pem" -in "$OUT_DIR/site-cert.pem" -passout pass:test \
      -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 -out "$OUT_DIR/site-cert.p12"
    spki=$(openssl x509 -in "$OUT_DIR/site-cert.pem" -pubkey -noout | openssl pkey -pubin -outform der \
      | openssl dgst -sha256 -binary | base64)
    rm -f "$OUT_DIR/site-key.pem"
    chmod 644 "$OUT_DIR/site-cert.p12"
    echo "$flags --host-resolver-rules=\"MAP dubsector.github.io:443 127.0.0.1:8443\" --ignore-certificate-errors-spki-list=$spki --disable-quic" \
      > "$OUT_DIR/chrome-command-line-local"
    # Orchestrator runs each test in its own instrumentation with the app's
    # data cleared, so one test can't leave anything behind for the next.
    args+=(--type instrumentation --test "$TEST_APK" --use-orchestrator
      --other-files "/data/local/tmp/smoke-test.mp4=$OUT_DIR/smoke-test.mp4,/data/local/tmp/chrome-command-line=$OUT_DIR/chrome-command-line,/data/local/tmp/chrome-command-line-live=$OUT_DIR/chrome-command-line-live,/data/local/tmp/chrome-command-line-local=$OUT_DIR/chrome-command-line-local,/data/local/tmp/site.zip=$OUT_DIR/site.zip,/data/local/tmp/site-cert.p12=$OUT_DIR/site-cert.p12"
      --directories-to-pull /sdcard/test-lab)
    case "${TESTS:-all}" in
      all) ;;
      convert) args+=(--test-targets "class io.github.dubsector.videoshrinker.ShareAndBackgroundTest") ;;
      share) args+=(--test-targets "class io.github.dubsector.videoshrinker.ShareSourcesTest") ;;
      update) args+=(--test-targets "class io.github.dubsector.videoshrinker.UpdateDuringShareTest") ;;
      *) echo "TESTS must be all, convert, share or update" >&2; exit 2 ;;
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

# Runs on one device: run_on MODEL VERSION ENGINE RESULTS_DIR.
run_on() {
  local extra=(--device "model=$1,version=$2,locale=en,orientation=portrait" --results-dir "$4")
  [ "$TYPE" != instrumentation ] || extra+=(--environment-variables "engine=$3,clearPackageData=true")
  status=0
  gcloud firebase test android run "${args[@]}" "${extra[@]}" 2>&1 | tee "$OUT_DIR/gcloud.log" || status=${PIPESTATUS[0]}
}

# The virtual device to fall back on: VIRTUAL_DEVICE_MODEL if Test Lab offers
# it, else its first virtual device; on OS_VERSION if offered, else the newest.
pick_virtual() {
  local model=${VIRTUAL_DEVICE_MODEL:-MediumPhone.arm} versions
  if ! versions=$(gcloud firebase test android models describe "$model" --format='value(supportedVersionIds)' 2> /dev/null) || [ -z "$versions" ]; then
    model=$(gcloud firebase test android models list --filter='form=VIRTUAL' --format='value(id)' | head -1)
    [ -n "$model" ] || return 1
    versions=$(gcloud firebase test android models describe "$model" --format='value(supportedVersionIds)')
  fi
  versions=$(tr ';, ' '\n\n\n' <<< "$versions" | grep -E '^[0-9]+$' | sort -n)
  [ -n "$versions" ] || return 1
  VIRTUAL_MODEL=$model
  if grep -qx "$OS_VERSION" <<< "$versions"; then VIRTUAL_VERSION=$OS_VERSION; else VIRTUAL_VERSION=$(tail -1 <<< "$versions"); fi
}

ENGINE=${ENGINE:-hardware}
run_on "$DEVICE_MODEL" "$OS_VERSION" "$ENGINE" "$RESULTS_DIR"

# The free plan's physical and virtual quotas are separate, so when the day's
# physical runs are used up a virtual device can usually still run.
fell_back=
if [ "$status" -ne 0 ] && [ "$form" = PHYSICAL ] && [ "${VIRTUAL_FALLBACK:-1}" = 1 ] \
  && grep -qiE 'insufficient testing quota|quota (exceeded|exhausted)|RESOURCE_EXHAUSTED' "$OUT_DIR/gcloud.log"; then
  mv "$OUT_DIR/gcloud.log" "$OUT_DIR/gcloud-physical.log"
  if pick_virtual; then
    fell_back="$DEVICE_MODEL had no testing quota left, so this ran on a virtual device, with any encoder accepted (virtual devices have no hardware encoder)"
    echo "::warning::$fell_back: $VIRTUAL_MODEL, Android API $VIRTUAL_VERSION"
    DEVICE_MODEL=$VIRTUAL_MODEL OS_VERSION=$VIRTUAL_VERSION ENGINE=any RESULTS_DIR=$RESULTS_DIR-virtual
    run_on "$DEVICE_MODEL" "$OS_VERSION" "$ENGINE" "$RESULTS_DIR"
  else
    echo "::warning::$DEVICE_MODEL had no testing quota left, and no virtual device to fall back on was found"
    cp "$OUT_DIR/gcloud-physical.log" "$OUT_DIR/gcloud.log"
  fi
fi

# gcloud names the bucket it stored the results in as a console link.
bucket=${RESULTS_BUCKET:-}; bucket=${bucket#gs://}
[ -n "$bucket" ] || bucket=$(grep -oE 'storage/browser/[^/]+' "$OUT_DIR/gcloud.log" | head -1 | cut -d/ -f3 || true)
report=$(grep -oE 'https://console\.firebase\.google\.com/[^] ]+' "$OUT_DIR/gcloud.log" | head -1 || true)
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

# The tests log the device's Chrome version. Test Lab's phones don't always
# have a current Chrome (the Pixel 9 Pro XL had 128), and a run on an old one
# can pass while the share is broken on current Chrome.
chrome=$(find "$OUT_DIR" -name logcat -exec grep -hoE 'TestLabSmoke.*Chrome [0-9][0-9.]*' {} + 2> /dev/null \
  | grep -oE 'Chrome [0-9][0-9.]*' | head -1 | cut -d' ' -f2 || true)
old_chrome=
if [ -n "$chrome" ]; then
  echo "Chrome on the device: $chrome"
  if [ "${chrome%%.*}" -lt "$MIN_CHROME" ]; then
    old_chrome="Chrome on $DEVICE_MODEL is $chrome, older than $MIN_CHROME, so this run doesn't show how the app behaves on current Chrome"
    echo "::warning::$old_chrome"
  fi
elif [ "$TYPE" = instrumentation ]; then
  echo "Couldn't tell which Chrome the device has (no test log)"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "## Firebase Test Lab ($TYPE)"
    [ -z "$old_chrome" ] || echo "> [!WARNING]"$'\n'"> $old_chrome."$'\n'
    [ -z "$fell_back" ] || echo "> [!WARNING]"$'\n'"> Fell back to a virtual device: $fell_back."$'\n'
    echo "- Device: $DEVICE_MODEL, Android API $OS_VERSION ($([ -n "$fell_back" ] && echo virtual || echo "${form,,}"))"
    echo "- Engine required: $ENGINE"
    echo "- Chrome on the device: ${chrome:-unknown}"
    echo "- Result: $([ "$status" -eq 0 ] && echo passed || echo "failed (gcloud exit code $status)")"
    [ -z "$report" ] || echo "- [Full report, with video, in the Firebase console]($report)"
  } >> "$GITHUB_STEP_SUMMARY"
fi

exit "$status"
