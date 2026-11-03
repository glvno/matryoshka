#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Build the FM-1 simulator for onboarding tests (firmware/test/fm1_sim.c) into build/fm1_sim/fm1_sim.
set -e
cd "$(dirname "$0")/../.."
mkdir -p build/fm1_sim
gcc -O1 -Wno-unused-function -Wno-unused-result -Wno-macro-redefined -o build/fm1_sim/fm1_sim firmware/test/fm1_sim.c
