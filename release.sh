#!/usr/bin/env bash
#
# Cut a GitHub release of the version in package.json:
#
#   ./release.sh
#
# Builds the desktop app fresh, zips it, tags v<version> and publishes the zip
# with notes generated from the commits since the last release. The iOS app
# ships as source only: a built .app is signed to one Apple team and its
# devices, so it would install for nobody else.
set -euo pipefail
cd "$(dirname "$0")"

version=$(node -p "require('./package.json').version")
desktop_version=$(node -p "require('./desktop/package.json').version")
tag="v${version}"

# electron-builder stamps the app with desktop/package.json's version, so the
# two must agree or the download says a different version than its release.
if [ "$version" != "$desktop_version" ]; then
  echo "package.json says ${version} but desktop/package.json says ${desktop_version}." >&2
  echo "Set both to the version you're releasing, commit, and re-run." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "The working tree has uncommitted changes, so the release wouldn't match GitHub." >&2
  echo "Commit or stash them, push, and re-run." >&2
  exit 1
fi

git fetch -q origin
if [ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ]; then
  echo "HEAD isn't what's on origin, so the tag would point at code GitHub doesn't have." >&2
  echo "Push (or pull) first: git push" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null || gh release view "$tag" >/dev/null 2>&1; then
  echo "${tag} already exists. Bump the version in package.json and desktop/package.json first." >&2
  exit 1
fi

./build.sh package

zip="desktop/dist/Ansa-${version}-mac-arm64.zip"
rm -f "$zip"
# ditto rather than zip: it keeps the bundle's symlinks and code signature intact.
ditto -c -k --keepParent desktop/dist/mac-arm64/Ansa.app "$zip"

git tag -a "$tag" -m "Ansa ${version}"
git push origin "refs/tags/${tag}"
gh release create "$tag" "$zip" --title "Ansa ${version}" --generate-notes --verify-tag
echo "Released ${tag}: $(gh release view "$tag" --json url -q .url)"
