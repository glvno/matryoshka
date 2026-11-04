#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-only
# Install the naive-owner agent (fm1-naive-owner.md) into ~/.claude/agents/, pointed at this checkout's server.py.
# Claude Code reads it when an agent starts; run again after moving the checkout.
set -e
cd "$(dirname "$0")/../.."
mkdir -p "$HOME/.claude/agents"
sed "s|REPO/|$(pwd)/|" tools/fm1_sim/fm1-naive-owner.md > "$HOME/.claude/agents/fm1-naive-owner.md"
echo "installed: $HOME/.claude/agents/fm1-naive-owner.md -> $(pwd)/tools/fm1_sim/server.py"
