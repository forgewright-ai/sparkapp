#!/bin/bash
# sparkchat production build -- macos, windows (xwin cross-compile), or all.
set -e

TARGET="${1:-macos}"
case "$TARGET" in macos|windows|all) ;; *)
  echo "usage: $0 [macos|windows|all]" >&2; exit 1;; esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
. "$HOME/.cargo/env" 2>/dev/null || true

# .cargo/config.toml carries machine paths, so it stays out of git --
# generate it here when missing.
ensure_cargo_config() {
  local cfg="src-tauri/.cargo/config.toml"
  [ -f "$cfg" ] && return 0
  cat > "$cfg" <<EOF
[target.x86_64-pc-windows-msvc]
linker = ".cargo/xwin-clang.sh"
ar = "/opt/homebrew/opt/llvm/bin/llvm-ar"
rustflags = [
    "-C", "link-arg=-L$HOME/.xwin/sdk/lib/um/x86_64",
    "-C", "link-arg=-L$HOME/.xwin/sdk/lib/ucrt/x86_64",
    "-C", "link-arg=-L$HOME/.xwin/crt/lib/x86_64",
]

[env]
XWIN_ROOT = "$HOME/.xwin"
EOF
  echo "generated $cfg"
}

build_macos() {
  echo "== building macos =="
  unset CI
  # tauri's own dmg step drives Finder via applescript and fails headless;
  # bundle the .app, then wrap it with hdiutil ourselves.
  npm run tauri -- build --bundles app
  local ver bundle stage
  ver=$(node -p "require('./package.json').version")
  bundle="src-tauri/target/release/bundle"
  stage="$bundle/dmg-stage"
  rm -rf "$stage" && mkdir -p "$stage" "$bundle/dmg"
  cp -R "$bundle/macos/spark.app" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname spark -srcfolder "$stage" -ov -format UDZO \
    "$bundle/dmg/spark_${ver}_aarch64.dmg"
  rm -rf "$stage"
  ls -lh "$bundle"/dmg/*.dmg
}

build_windows() {
  echo "== building windows (x86_64-pc-windows-msvc) =="
  rustup target list --installed | grep -q x86_64-pc-windows-msvc \
    || { echo "run: rustup target add x86_64-pc-windows-msvc" >&2; exit 1; }
  command -v xwin >/dev/null || { echo "run: cargo install xwin --locked" >&2; exit 1; }
  export XWIN_ROOT="${XWIN_ROOT:-$HOME/.xwin}"
  [ -d "$XWIN_ROOT" ] || { echo "run: xwin --accept-license splat --output $XWIN_ROOT" >&2; exit 1; }
  ensure_cargo_config

  WRAPPER="$(pwd)/src-tauri/.cargo/xwin-clang.sh"
  export CC_x86_64_pc_windows_msvc="$WRAPPER"
  export CXX_x86_64_pc_windows_msvc="$WRAPPER"
  export CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER="$WRAPPER"
  export AR_x86_64_pc_windows_msvc="/opt/homebrew/opt/llvm/bin/llvm-ar"
  export LLVM_RC="/opt/homebrew/opt/llvm/bin/llvm-rc"
  export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
  command -v makensis >/dev/null || { echo "run: brew install nsis" >&2; exit 1; }

  unset CI
  npm run tauri -- build --target x86_64-pc-windows-msvc --bundles nsis
  ls -lh src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
}

ensure_cargo_config
case "$TARGET" in
  macos)   build_macos ;;
  windows) build_windows ;;
  all)     build_macos; build_windows ;;
esac
echo "done"
