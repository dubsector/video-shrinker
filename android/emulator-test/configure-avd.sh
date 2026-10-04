#!/usr/bin/env bash
# Gives the emulator a Pixel 9 Pro XL's screen: 1344x2992 at 480 dpi, so
# 448dp wide like the phone. android-emulator.yml runs this after the AVD is
# created and before the emulator starts.
#
# Usage: android/emulator-test/configure-avd.sh [avd-name]
set -euo pipefail

config=${ANDROID_AVD_HOME:-$HOME/.android/avd}/${1:-test}.avd/config.ini
# A skin would override the size set here, so drop it along with any old size.
sed -i '/^hw\.lcd\.\(width\|height\|density\)=/d; /^skin\./d' "$config"
printf 'hw.lcd.width=1344\nhw.lcd.height=2992\nhw.lcd.density=480\n' >> "$config"
grep '^hw\.lcd\.' "$config"
