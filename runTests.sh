#!/usr/bin/env bash

set -e

# system="$(nix eval --impure --json --expr builtins.currentSystem | jq -r)"

# Run every task through a timeout so a scheduling deadlock (e.g. the reverse /
# --only-tags dependency-ordering bug) fails fast and clearly instead of hanging
# forever — a hang doesn't trip `set -e`, a non-zero timeout exit does.
nt() { timeout "${NIX_TASK_TEST_TIMEOUT:-300}" nix-task run "$@"; }

pushd examples/nixMathHomework

# nt -g .#

nt .#

popd

rm -rf .nix-task || true

nt ./examples/nixMathHomework#

nt --only ./examples/nixMathHomework#example.calculate.add_3_and_7
nt --reverse --custom destroy --only-tags test_calculate -g ./examples/nixMathHomework#
nt --reverse --custom destroy --only-tags test_calculate ./examples/nixMathHomework#
nt --only ./examples/nixMathHomework#example.execTest

# clear output directory and try running in reverse again, previous outputs should have "fetchOutput" called
rm -rf .nix-task || true
nt --reverse --custom destroy --only-tags test_calculate ./examples/nixMathHomework#example.calculate

# clear output directory and try filtering by tag where dependency outputs need to be fetched
rm -rf .nix-task || true
nt --only-tags test_result ./examples/nixMathHomework#

# mimic a typical deployment
nt -g --only-tags test_e2e ./examples/nixMathHomework#complex_environment_example_1
