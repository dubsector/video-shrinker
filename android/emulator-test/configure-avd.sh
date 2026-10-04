#!/usr/bin/env bash
# Sets the emulator's screen. android-emulator.yml runs this after the AVD is
# created and before the emulator starts.
#
#   pixel (default)  a Pixel 9 Pro XL: 1344x2992 at 480 dpi, so 448dp wide
#   WIDTHxHEIGHT     that size at 420 dpi, like most other phones
#
# Usage: android/emulator-test/configure-avd.sh [avd-name] [screen]
set -euo pipefail

config=${ANDROID_AVD_HOME:-$HOME/.android/avd}/${1:-test}.avd/config.ini
screen=${2:-pixel}
case $screen in
  pixel) width=1344 height=2992 density=480 ;;
  *x*) width=${screen%x*} height=${screen#*x} density=420 ;;
  *) echo "unknown screen: $screen" >&2; exit 1 ;;
esac
# A skin would override the size set here, so drop it along with any old size.
sed -i '/^hw\.lcd\.\(width\|height\|density\)=/d; /^skin\./d' "$config"
printf 'hw.lcd.width=%s\nhw.lcd.height=%s\nhw.lcd.density=%s\n' "$width" "$height" "$density" >> "$config"
grep '^hw\.lcd\.' "$config"
