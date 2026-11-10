#!/bin/sh
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM

rustc --test "$here/host-boundary.rs" -o "$temp_dir/host-boundary-tests"
"$temp_dir/host-boundary-tests"
node --test "$here/readiness.test.mjs" "$here/native-run.test.mjs"
