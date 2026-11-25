#!/usr/bin/env bash
# Runs inside the CI emulator: install, open, add data, restart, update-install.
set -euo pipefail
PKG=com.akhtar.autos.desktop
APK="$1"
OUT="$RUNNER_TEMP/smoke"
mkdir -p "$OUT"
trap 'adb logcat -d > "$OUT/logcat.txt" || true' EXIT
launch() { adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null; sleep 8; }

adb install "$APK"
launch
node e2e/smoke.cjs android add "$OUT/android-add.png"
adb shell am force-stop "$PKG"
launch
node e2e/smoke.cjs android verify "$OUT/android-restart.png"
adb shell am force-stop "$PKG"
adb install -r "$APK"
launch
node e2e/smoke.cjs android verify "$OUT/android-reinstall.png"
echo "ANDROID SMOKE PASS: install, add item, restart, reinstall"
