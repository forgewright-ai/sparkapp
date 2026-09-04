#!/bin/bash
# xwin clang wrapper for Windows cross-compilation

XWIN_ROOT="${XWIN_ROOT:-$HOME/.xwin}"

# Find Windows SDK version (may be a symlink pointing to current directory)
SDK_VERSION_DIR=$(find "$XWIN_ROOT/sdk/include" -maxdepth 1 -type d -name "10.*" 2>/dev/null | sort -V | tail -1)
# If version dir is a symlink to current dir, don't use it (headers are directly in include/)
if [ -n "$SDK_VERSION_DIR" ] && [ "$(readlink -f "$SDK_VERSION_DIR" 2>/dev/null)" = "$(readlink -f "$XWIN_ROOT/sdk/include" 2>/dev/null)" ]; then
    SDK_VERSION_DIR=""
fi

# Check if this is a compilation (-c flag) or linking command
IS_COMPILE=false
IS_LINK=false
for arg in "$@"; do
    if [[ "$arg" == "-c" ]]; then
        IS_COMPILE=true
        break
    fi
    # Check for linker flags (MSVC-style or clang-style)
    if [[ "$arg" == /DEF:* ]] || [[ "$arg" == /OUT:* ]] || [[ "$arg" == /DLL ]] || [[ "$arg" == /NOLOGO ]] || [[ "$arg" == *.lib ]] || [[ "$arg" == /LIBPATH:* ]] || [[ "$arg" == /NODEFAULTLIB:* ]] || [[ "$arg" == /DEFAULTLIB:* ]] || [[ "$arg" == /OPT:* ]] || [[ "$arg" == /IMPLIB:* ]] || [[ "$arg" == /DEBUG ]] || [[ "$arg" == /NXCOMPAT ]] || [[ "$arg" == /NATVIS:* ]] || [[ "$arg" == /PDBALTPATH:* ]]; then
        IS_LINK=true
    fi
done

# If we have object files and no -c flag, it's likely linking
if [ "$IS_COMPILE" != true ] && (echo "$@" | grep -q "\.o\|\.rlib\|\.lib"); then
    IS_LINK=true
fi

# Set up include paths (for compilation)
INCLUDE_PATHS=()
if [ "$IS_COMPILE" = true ]; then
    INCLUDE_PATHS=(
        "-isystem$XWIN_ROOT/sdk/include/ucrt"
        "-isystem$XWIN_ROOT/sdk/include/shared"
        "-isystem$XWIN_ROOT/sdk/include/um"
        "-isystem$XWIN_ROOT/sdk/include/winrt"
        "-isystem$XWIN_ROOT/crt/include"
    )
    
    if [ -n "$SDK_VERSION_DIR" ]; then
        INCLUDE_PATHS+=(
            "-isystem$SDK_VERSION_DIR/ucrt"
            "-isystem$SDK_VERSION_DIR/shared"
            "-isystem$SDK_VERSION_DIR/um"
            "-isystem$SDK_VERSION_DIR/winrt"
        )
    fi
    # Execute clang for compilation
    exec clang "${INCLUDE_PATHS[@]}" "$@"
fi

# For linking, use clang with lld and translate MSVC arguments
if [ "$IS_LINK" = true ]; then
    # Translate MSVC-style linker arguments to clang-style
    CLANG_ARGS=()
    OBJECT_FILES=()
    LIB_PATHS=(
        "-L$XWIN_ROOT/sdk/lib/um/x86_64"
        "-L$XWIN_ROOT/sdk/lib/ucrt/x86_64"
        "-L$XWIN_ROOT/crt/lib/x86_64"
    )
    LLD_ARGS=()
    
    for arg in "$@"; do
        case "$arg" in
            /DEF:*)
                # DEF file - pass to lld via -Wl
                DEF_PATH="${arg#/DEF:}"
                LLD_ARGS+=("/DEF:$DEF_PATH")
                ;;
            /OUT:*)
                # Output file
                OUT_PATH="${arg#/OUT:}"
                CLANG_ARGS+=("-o" "$OUT_PATH")
                ;;
            /DLL)
                # Create DLL
                CLANG_ARGS+=("--shared")
                ;;
            /NOLOGO)
                # Ignore - clang doesn't have this flag
                ;;
            /LIBPATH:*)
                # Library path
                LIB_PATH="${arg#/LIBPATH:}"
                LIB_PATHS+=("-L$LIB_PATH")
                ;;
            /NODEFAULTLIB:*)
                # Ignore default library - pass to lld
                LIB_NAME="${arg#/NODEFAULTLIB:}"
                LLD_ARGS+=("/NODEFAULTLIB:$LIB_NAME")
                ;;
            /defaultlib:*|/DEFAULTLIB:*)
                # Link default library - pass to lld
                LIB_NAME="${arg#/defaultlib:}"
                LIB_NAME="${LIB_NAME#/DEFAULTLIB:}"
                LLD_ARGS+=("/DEFAULTLIB:$LIB_NAME")
                ;;
            /OPT:*)
                # Optimization flags - translate to lld-link format
                OPT_FLAGS="${arg#/OPT:}"
                # lld-link expects /OPT:REF and /OPT:ICF as separate flags
                if [[ "$OPT_FLAGS" == *"REF"* ]]; then
                    LLD_ARGS+=("/OPT:REF")
                fi
                if [[ "$OPT_FLAGS" == *"ICF"* ]]; then
                    LLD_ARGS+=("/OPT:ICF")
                fi
                ;;
            /IMPLIB:*)
                # Import library - pass to lld
                IMPLIB_PATH="${arg#/IMPLIB:}"
                LLD_ARGS+=("/IMPLIB:$IMPLIB_PATH")
                ;;
            /DEBUG)
                # Debug info
                CLANG_ARGS+=("-g")
                LLD_ARGS+=("/DEBUG")
                ;;
            /NXCOMPAT)
                # NX compatible - pass to lld
                LLD_ARGS+=("/NXCOMPAT")
                ;;
            /NATVIS:*)
                # Debug visualization - pass to lld
                NATVIS_PATH="${arg#/NATVIS:}"
                LLD_ARGS+=("/NATVIS:$NATVIS_PATH")
                ;;
            /PDBALTPATH:*)
                # PDB path - pass to lld
                PDB_PATH="${arg#/PDBALTPATH:}"
                LLD_ARGS+=("/PDBALTPATH:$PDB_PATH")
                ;;
            /SUBSYSTEM:*)
                # Subsystem - pass to lld
                SUBSYSTEM="${arg#/SUBSYSTEM:}"
                LLD_ARGS+=("/SUBSYSTEM:$SUBSYSTEM")
                ;;
            /ENTRY:*)
                # Entry point - pass to lld
                ENTRY="${arg#/ENTRY:}"
                LLD_ARGS+=("/ENTRY:$ENTRY")
                ;;
            *.lib)
                # Library file - always convert to -l format for clang
                # Extract library name (remove path and .lib extension)
                LIB_NAME=$(basename "$arg" .lib)
                # Convert to -l format (clang will search library paths)
                CLANG_ARGS+=("-l$LIB_NAME")
                ;;
            *.rlib|*.o|symbols.o)
                # Object/library files
                OBJECT_FILES+=("$arg")
                ;;
            -L*)
                # Library path (already in clang format)
                LIB_PATHS+=("$arg")
                ;;
            *)
                # Check if it's a file path or other argument
                if [[ "$arg" == /* ]] && [ -f "$arg" ]; then
                    OBJECT_FILES+=("$arg")
                elif [[ "$arg" == {* ]]; then
                    # Rust glob pattern - pass through
                    OBJECT_FILES+=("$arg")
                else
                    # Other arguments - pass through
                    CLANG_ARGS+=("$arg")
                fi
                ;;
        esac
    done
    
    # Build the final command
    # Use -Wl to pass arguments to lld linker
    LLD_FLAGS=()
    for lld_arg in "${LLD_ARGS[@]}"; do
        LLD_FLAGS+=("-Wl,$lld_arg")
    done
    
    # Use clang for Windows linking
    # Try to use lld if available, otherwise use default linker
    # First try with explicit lld path, then fall back to default
    if [ -f "/opt/homebrew/opt/llvm/bin/lld" ]; then
        exec clang -fuse-ld=/opt/homebrew/opt/llvm/bin/lld -target x86_64-pc-windows-msvc "${LIB_PATHS[@]}" "${CLANG_ARGS[@]}" "${LLD_FLAGS[@]}" "${OBJECT_FILES[@]}"
    elif command -v lld >/dev/null 2>&1; then
        exec clang -fuse-ld=lld -target x86_64-pc-windows-msvc "${LIB_PATHS[@]}" "${CLANG_ARGS[@]}" "${LLD_FLAGS[@]}" "${OBJECT_FILES[@]}"
    else
        # Fall back to default linker (might not work for Windows, but worth trying)
        exec clang -target x86_64-pc-windows-msvc "${LIB_PATHS[@]}" "${CLANG_ARGS[@]}" "${LLD_FLAGS[@]}" "${OBJECT_FILES[@]}"
    fi
fi

# Default: just pass through to clang
exec clang "$@"

