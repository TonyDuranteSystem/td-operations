#!/bin/bash
# Builds the PRODUCTION app bundle (the .aab file Google Play takes) signed with the Google Play upload key.
# The key file lives outside the repository (~/.td-android/td-upload.keystore) and its password in the Mac's Keychain
# (service "td-android-upload-keystore"); neither is ever printed or stored here.
#   bash android/TDClient/release-bundle.sh
set -euo pipefail
cd "$(dirname "$0")"
STORE="${TD_UPLOAD_STORE_FILE:-$HOME/.td-android/td-upload.keystore}"
[ -f "$STORE" ] || { echo "No upload key file at $STORE" >&2; exit 1; }
PASSWORD="$(security find-generic-password -s td-android-upload-keystore -w)"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
TD_UPLOAD_STORE_FILE="$STORE" TD_UPLOAD_STORE_PASSWORD="$PASSWORD" ./gradlew :app:bundleProductionRelease --console=plain
echo "Bundle: $(pwd)/app/build/outputs/bundle/productionRelease/app-production-release.aab"
