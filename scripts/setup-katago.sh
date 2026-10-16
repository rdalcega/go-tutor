#!/usr/bin/env bash
# Idempotent KataGo setup for Go Tutor:
#   1. checks `katago` is on PATH,
#   2. finds the main net (or uses $KATAGO_MODEL),
#   3. downloads the human-SL net into katago/ if missing,
#   4. writes katago/analysis.cfg from the bundled analysis_example.cfg.
# Winrates and scores are reported from the side to move
# (reportAnalysisWinratesAs = SIDETOMOVE); src/server/katago.ts relies on that.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KDIR="$ROOT/katago"
HUMAN_URL="https://github.com/lightvector/KataGo/releases/download/v1.15.0/b18c384nbt-humanv0.bin.gz"
HUMAN_NET="${KATAGO_HUMAN_MODEL:-$KDIR/b18c384nbt-humanv0.bin.gz}"
CFG="$KDIR/analysis.cfg"

if ! command -v katago >/dev/null 2>&1; then
  echo "error: katago is not on PATH. Install it with: brew install katago" >&2
  exit 1
fi
echo "katago: $(command -v katago) ($(katago version | head -n1))"

SHARE=""
if command -v brew >/dev/null 2>&1 && brew --prefix katago >/dev/null 2>&1; then
  SHARE="$(brew --prefix katago)/share/katago"
fi

if [[ -n "${KATAGO_MODEL:-}" ]]; then
  MODEL="$KATAGO_MODEL"
else
  MODEL="$(ls -1 "$SHARE"/kata1-b18c384nbt-*.bin.gz 2>/dev/null | sort | tail -n1 || true)"
fi
if [[ -z "$MODEL" || ! -f "$MODEL" ]]; then
  echo "error: main net not found (looked for $SHARE/kata1-b18c384nbt-*.bin.gz). Set KATAGO_MODEL." >&2
  exit 1
fi
echo "main net: $MODEL"

mkdir -p "$KDIR"
if [[ ! -s "$HUMAN_NET" ]]; then
  echo "downloading human-SL net to $HUMAN_NET ..."
  curl -fL --retry 3 -o "$HUMAN_NET.part" "$HUMAN_URL"
  mv "$HUMAN_NET.part" "$HUMAN_NET"
fi
echo "human net: $HUMAN_NET"

EXAMPLE="$SHARE/configs/analysis_example.cfg"
if [[ ! -f "$EXAMPLE" ]]; then
  echo "error: bundled config not found at $EXAMPLE" >&2
  exit 1
fi

# Metal backend layout (KATAGO_BACKEND):
#   mux (default): 2 GPU + 2 Neural Engine server threads. Measured on an M1: ~30 s startup,
#                  ~1.4 s for 400 visits on 9x9.
#   gpu:           GPU only. ~2 s startup but ~5 s for 400 visits.
BACKEND="${KATAGO_BACKEND:-mux}"
case "$BACKEND" in
  mux)
    BATCH=4
    BACKEND_EDIT='/Example: mux mode/,/Example: GPU-only/s/^# (numNNServerThreadsPerModel = 4|metalDeviceToUseThread[0-3] = [0-9]+)$/\1/'
    ;;
  gpu)
    BATCH=16
    BACKEND_EDIT='s/^$//'
    ;;
  *)
    echo "error: KATAGO_BACKEND must be mux or gpu (got $BACKEND)" >&2
    exit 1
    ;;
esac

# Rewrite the keys we care about; everything else stays as in the bundled example.
sed -E \
  -e "s|^logDir = .*|logDir = $KDIR/logs|" \
  -e "s|^reportAnalysisWinratesAs = .*|reportAnalysisWinratesAs = SIDETOMOVE|" \
  -e "s|^maxVisits = .*|maxVisits = 400|" \
  -e "s|^numAnalysisThreads = .*|numAnalysisThreads = 2|" \
  -e "s|^numSearchThreadsPerAnalysisThread = .*|numSearchThreadsPerAnalysisThread = 8|" \
  -e "s|^nnMaxBatchSize = .*|nnMaxBatchSize = $BATCH|" \
  -e "$BACKEND_EDIT" \
  -e "s|^nnCacheSizePowerOfTwo = .*|nnCacheSizePowerOfTwo = 20|" \
  -e "s|^nnMutexPoolSizePowerOfTwo = .*|nnMutexPoolSizePowerOfTwo = 14|" \
  "$EXAMPLE" > "$CFG.tmp"
mv "$CFG.tmp" "$CFG"

for key in logDir reportAnalysisWinratesAs maxVisits numAnalysisThreads numSearchThreadsPerAnalysisThread; do
  if ! grep -Eq "^$key = " "$CFG"; then
    echo "error: failed to set $key in $CFG" >&2
    exit 1
  fi
done
if [[ "$BACKEND" == mux ]] && ! grep -Eq "^numNNServerThreadsPerModel = 4" "$CFG"; then
  echo "error: could not enable the Metal mux layout in $CFG; rerun with KATAGO_BACKEND=gpu" >&2
  exit 1
fi
echo "config: $CFG (backend: $BACKEND)"
echo "launch: katago analysis -config $CFG -model $MODEL -human-model $HUMAN_NET"
