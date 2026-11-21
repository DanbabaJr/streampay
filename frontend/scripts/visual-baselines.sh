#!/usr/bin/env bash
# ==============================================================================
# visual-baselines.sh — render the Storybook visual baselines (or check them)
# in the exact container CI compares in.
# ==============================================================================
# Baselines are only comparable inside the renderer that produced them, so this
# runs the pinned Playwright image rather than your local browser. The host's
# node_modules is shadowed by a container-only volume, so the Linux install
# never overwrites your macOS/Windows one.
#
# Usage (from anywhere):
#   bash frontend/scripts/visual-baselines.sh           # re-render every baseline
#   bash frontend/scripts/visual-baselines.sh --check   # compare only, like CI
#
# No Docker? Push the branch: when the comparison fails, the storybook-visual
# CI job re-renders the missing/changed baselines in the same image and uploads
# them as the `visual-baselines-linux` artifact. Unpack it into
# frontend/visual/__screenshots__/linux/.
# ==============================================================================

set -euo pipefail

# Keep in step with @playwright/test in package.json and the CI container tag.
IMAGE="mcr.microsoft.com/playwright:v1.64.1-noble"

FRONTEND="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mode="update"
if [ "${1:-}" = "--check" ]; then
  mode="check"
fi

if [ "$mode" = "update" ]; then
  test_cmd="npx playwright test stories.visual.ts --update-snapshots=all"
else
  test_cmd="npx playwright test"
fi

docker run --rm \
  --platform linux/amd64 \
  -e CI=1 \
  -v "$FRONTEND":/work \
  -v /work/node_modules \
  -w /work \
  "$IMAGE" \
  bash -c "npm ci --no-audit --no-fund && npm run build-storybook && $test_cmd"

if [ "$mode" = "update" ]; then
  echo
  echo "Baselines written to frontend/visual/__screenshots__/linux/."
  echo "Review them (git diff --stat; open the PNGs) before committing."
fi
