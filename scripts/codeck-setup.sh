#!/bin/bash
# Codeck first-run setup.
#
# Codeck runs entirely on this machine, so the models have to live here too.
# This is the only step that needs the network; afterwards the Mac can stay
# offline permanently.
#
# Usage:  bash codeck-setup.sh
set -uo pipefail

OLLAMA_DIR="$HOME/.ollama"
BIN_DIR="$OLLAMA_DIR/bin"
CODECK_DIR="$HOME/.codeck"
LLM_MODEL="${LOCAL_MODEL:-qwen2.5:3b-instruct}"
EMBED_MODEL="${EMBED_MODEL:-nomic-embed-text}"
# q5_1 quantisation: measured ~2.5x faster than the fp16 weights on a 4-core
# Intel Mac, with no meaningful accuracy difference on speech. 190 MB vs 487 MB.
WHISPER_MODEL="${WHISPER_MODEL:-small.en-q5_1}"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
err()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }

say "Codeck setup"
echo "  Downloads about 2.5 GB of models. One time only."

# ── hardware note ────────────────────────────────────────────────────────────
ARCH=$(uname -m)
RAM=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
echo "  This Mac: $ARCH, ${RAM} GB RAM"
if [ "$ARCH" = "arm64" ] && [ "$RAM" -ge 24 ]; then
  warn "Apple Silicon with ${RAM} GB — you can run a much better model."
  warn "After setup, try:  ollama pull qwen2.5:14b-instruct"
  warn "then set LOCAL_MODEL=qwen2.5:14b-instruct in Codeck's Settings."
elif [ "$ARCH" = "x86_64" ]; then
  warn "Intel Mac — inference is CPU-only here, so expect a few minutes per deck."
fi

# ── 1. Ollama ────────────────────────────────────────────────────────────────
say "1/4  Local model runtime (Ollama)"
if command -v ollama >/dev/null 2>&1; then
  OLLAMA_BIN=$(command -v ollama); ok "already installed: $OLLAMA_BIN"
elif [ -x "$BIN_DIR/ollama" ]; then
  OLLAMA_BIN="$BIN_DIR/ollama"; ok "found at $OLLAMA_BIN"
else
  echo "  Downloading Ollama…"
  mkdir -p "$BIN_DIR"
  TGZ=$(mktemp -t ollama).tgz
  if curl -fL# --retry 3 -o "$TGZ" \
      "https://github.com/ollama/ollama/releases/latest/download/ollama-darwin.tgz"; then
    tar xzf "$TGZ" -C "$BIN_DIR" && rm -f "$TGZ"
    chmod +x "$BIN_DIR/ollama"
    OLLAMA_BIN="$BIN_DIR/ollama"; ok "installed to $BIN_DIR"
  else
    err "Download failed. Install manually:  brew install ollama"; exit 1
  fi
fi

# ── 2. start it ──────────────────────────────────────────────────────────────
say "2/4  Starting the model server"
if curl -sf --max-time 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  ok "already running"
else
  "$OLLAMA_BIN" serve > "$OLLAMA_DIR/serve.log" 2>&1 &
  for _ in $(seq 1 30); do
    curl -sf --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break
    sleep 1
  done
  if curl -sf --max-time 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    ok "started (log: $OLLAMA_DIR/serve.log)"
  else
    err "Could not start it. See $OLLAMA_DIR/serve.log"; exit 1
  fi
fi

# ── 3. models ────────────────────────────────────────────────────────────────
say "3/4  Models"
for m in "$LLM_MODEL" "$EMBED_MODEL"; do
  if "$OLLAMA_BIN" list 2>/dev/null | awk '{print $1}' | grep -qx "$m"; then
    ok "$m already present"
  else
    echo "  Pulling $m …"
    "$OLLAMA_BIN" pull "$m" && ok "$m" || { err "failed to pull $m"; exit 1; }
  fi
done

# ── 4. transcription ─────────────────────────────────────────────────────────
say "4/4  Transcription (whisper.cpp)"
mkdir -p "$CODECK_DIR/models"
MODEL_PATH="$CODECK_DIR/models/ggml-${WHISPER_MODEL}.bin"

if command -v whisper-cli >/dev/null 2>&1 || command -v whisper-cpp >/dev/null 2>&1; then
  ok "whisper.cpp installed"
elif command -v brew >/dev/null 2>&1; then
  echo "  Installing whisper-cpp and ffmpeg via Homebrew…"
  brew install whisper-cpp ffmpeg && ok "installed" || warn "install failed — do it manually: brew install whisper-cpp ffmpeg"
else
  warn "Homebrew not found. Install it from https://brew.sh, then:"
  warn "  brew install whisper-cpp ffmpeg"
fi

command -v ffmpeg >/dev/null 2>&1 && ok "ffmpeg present" || warn "ffmpeg missing — run: brew install ffmpeg"

if [ -f "$MODEL_PATH" ]; then
  ok "whisper model already present"
else
  echo "  Downloading the whisper model (~466 MB)…"
  curl -fL# --retry 3 -o "$MODEL_PATH" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${WHISPER_MODEL}.bin" \
    && ok "$MODEL_PATH" || { warn "download failed — live transcription will be unavailable"; rm -f "$MODEL_PATH"; }
fi

# ── done ─────────────────────────────────────────────────────────────────────
say "Done"
cat <<EOS
  Open Codeck. Settings will show a green status for each part.

  Two macOS permissions must be granted by hand, in System Settings →
  Privacy & Security (then relaunch Codeck):
    • Microphone       — to record your own voice
    • Screen Recording — to capture meeting audio from Zoom / Meet / Teams

  Keep Ollama running. To start it automatically at login:
    $OLLAMA_BIN serve &

  Nothing you record leaves this machine.
EOS
