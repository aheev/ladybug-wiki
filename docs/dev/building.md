# Building LadybugDB

**Source files:** `CMakeLists.txt`, `Makefile`, `cmake/`, `AGENTS.md`, `docs/build_tips.md`

## Prerequisites

- CMake ≥ 3.20
- C++20 compiler (GCC ≥ 11, Clang ≥ 14, MSVC 2022)
- Ninja (preferred) or GNU Make
- Python 3.8+ (for Python API and scripts)

## Quick Start

```bash
# Fastest for development — RelWithDebInfo has debug symbols but optimized code
make relwithdebinfo

# Pure release — fastest runtime, no debug symbols
make release

# Debug — assertions enabled, slowest runtime
make debug
```

The Makefile wraps CMake. All build artifacts go to `build/<type>/`.

## CMake Build Types

| Make Target | CMake Type | Notes |
|-------------|-----------|-------|
| `make release` | Release | `-O3`, no assertions, no debug symbols |
| `make debug` | Debug | `-O0`, assertions enabled, debug symbols |
| `make relwithdebinfo` | RelWithDebInfo | `-O2`, debug symbols, assertions off — recommended for development |

## Windows (PowerShell)

The `Makefile` doesn't work on Windows; use CMake + Ninja directly:

```powershell
# RelWithDebInfo — also generates compile_commands.json for clangd
cmake -B build/relwithdebinfo -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo .
cmake --build build/relwithdebinfo --config RelWithDebInfo

# Release
cmake -B build/release -G Ninja -DCMAKE_BUILD_TYPE=Release .
cmake --build build/release --config Release
```

## Build Targets

```bash
make all               # Everything: core + all language bindings + shell
make python            # Python API (produces _lbug.so)
make java              # Java API (JNI)
make nodejs            # Node.js API (native addon)
make shell             # Interactive Cypher shell CLI
make benchmark         # Benchmark harness
make example           # C/C++ example programs
make test-build        # Build test executables (RelWithDebInfo)
make test-build-release  # Build test executables (Release, faster to build)
```

## Extension Builds

Extensions live in `extension/` and are built separately:

```bash
make extension-build          # Build all extensions (Release)
make extension-debug          # Debug build of all extensions
make extension-release        # Release build of all extensions
make extension-test-build     # Build extension test executables
```

Available extensions: `algo`, `azure`, `delta`, `duckdb`, `fts`, `httpfs`, `iceberg`, `json`, `llm`, `neo4j`, `postgres`, `sqlite`, `unity_catalog`, `vector`.

## Sanitizers

```bash
make release ASAN=1    # Address Sanitizer — catches heap/stack overflows, use-after-free
make release TSAN=1    # Thread Sanitizer — catches data races
make release UBSAN=1   # Undefined Behavior Sanitizer — catches UB like integer overflow
```

Sanitizers are most useful in CI and when debugging crashes. Address Sanitizer adds ~2× memory overhead and 2× slowdown; Thread Sanitizer adds ~10× slowdown.

## Build Configuration Flags

Pass as `make <target> FLAG=value`:

```bash
# Runtime assertions in release builds
make release RUNTIME_CHECKS=1

# Treat all warnings as errors (used in CI)
make release WERROR=1

# Link-time optimization (slower build, faster runtime)
make release LTO=1

# Override page size (default: 4KB = 12)
make release PAGE_SIZE_LOG2=12

# Override vector capacity (default: 2048 = 11)
make release VECTOR_CAPACITY_LOG2=11
```

::: tip compile_commands.json
`make relwithdebinfo` produces `build/relwithdebinfo/compile_commands.json`, which enables clangd LSP completions and navigation in VS Code and other editors. Symlink it to the repo root:
```bash
ln -sf build/relwithdebinfo/compile_commands.json compile_commands.json
```
:::

## Code Formatting

Uses `clang-format-18`. Run it on modified files:

```bash
python3 scripts/run-clang-format.py \
  --clang-format-executable /usr/bin/clang-format-18 \
  -r src/my_module/
```

The `.clang-format` at the repo root defines the style. The `.clang-format-ignore` lists files excluded from formatting (generated code, third-party).

## Static Analysis (clang-tidy)

```bash
make tidy              # Run clang-tidy on all sources
make tidy-analyzer     # Run extended analyzer checks
make clangd-diagnostics  # Get clangd-level diagnostics
```

`clang-tidy` rules are in `.clang-tidy`. The analyzer variant uses `.clang-tidy-analyzer` with more aggressive checks.

## Tips & Tricks

### Parallel Builds

The `NUM_THREADS` variable controls build parallelism. It is **auto-detected** as ⌊nproc × 2/3⌋ so it doesn't pin every core. Override it when you want more or fewer parallel jobs:

```bash
# Use all CPUs (risky on low-RAM machines — each TU can take 1-2 GB peak)
NUM_THREADS=$(nproc) make relwithdebinfo

# Throttle to 4 threads to avoid swap
NUM_THREADS=4 make release

# Check what NUM_THREADS resolved to without building
make -n release | grep "cmake --build"
```

::: warning Memory pressure
Release builds with LTO or ASAN can peak at 2-3 GB RAM per parallel compile unit. If you see OOM kills, reduce `NUM_THREADS`.
:::

### ccache / sccache (Automatic)

CMake detects `ccache` or `sccache` automatically — no flags required:

```bash
# Install (Ubuntu/Debian)
sudo apt install ccache

# Install (macOS)
brew install ccache

# Verify it was picked up (look for "ccache found and enabled")
make relwithdebinfo 2>&1 | grep ccache
```

With ccache cold → warm the cache with a full build takes normal time. On subsequent `make` after `git pull` or branch switch, only changed translation units recompile. Cache directory: `~/.cache/ccache/`. Inspect with `ccache -s`.

For distributed/remote caching on CI, `sccache` is also auto-detected and takes priority over `ccache` if both are present.

### Use Ninja Directly for Fast Iteration

Once CMake has run, use `ninja -C <build-dir>` directly to skip CMake re-detection:

```bash
# Re-build only the e2e test runner after changing an operator
ninja -C build/relwithdebinfo test/runner/e2e_test

# Re-build only the transaction unit tests
ninja -C build/relwithdebinfo test/transaction/transaction_test

# List all available targets
ninja -C build/relwithdebinfo -t targets all | grep test | head -30

# Show which files would be compiled (dry run)
ninja -C build/relwithdebinfo -n lbug_object | head -20
```

### Incremental Rebuild After a Single File Change

```bash
# Touch a source file to force recompile
touch src/optimizer/filter_push_down_optimizer.cpp

# Rebuild only what changed (Ninja traces deps automatically)
ninja -C build/relwithdebinfo test/runner/e2e_test
```

### Speeding Up CMake Reconfiguration

```bash
# cmake --build skips re-configuration if CMakeLists.txt is unchanged
cmake --build build/relwithdebinfo --target e2e_test

# For VS Code: install the CMake Tools extension and point it at
# build/relwithdebinfo. It calls cmake+ninja automatically on save.
```

### Checking a Specific Operator

The processor operator code is in `src/processor/operator/`. To rebuild only the test binary after changing an operator:

```bash
ninja -C build/relwithdebinfo test/runner/e2e_test
```

### Using compile_commands.json with clangd

```bash
# Symlink to repo root so clangd finds it automatically
ln -sf build/relwithdebinfo/compile_commands.json compile_commands.json

# Or configure .clangd at repo root
cat > .clangd <<'EOF'
CompileFlags:
  CompilationDatabase: build/relwithdebinfo
EOF
```

This enables hover types, go-to-definition, and inline diagnostics in VS Code, Neovim, Emacs, etc.

### Debugging With GDB / LLDB

```bash
# Build with debug symbols
make debug

# Run with GDB — drops into debugger on first test failure
gdb --args build/debug/test/runner/e2e_test \
  --gtest_filter="*match~one_hop*" \
  --gtest_break_on_failure

# Run with LLDB on macOS
lldb -- build/debug/test/runner/e2e_test \
  --gtest_filter="*match~one_hop*" \
  --gtest_break_on_failure

# Attach to a running process
gdb -p <PID>
```

### SINGLE_THREADED Build (WASM / Embedded)

Disables `std::thread` usage throughout the engine (compiles with `-D__SINGLE_THREADED__`):

```bash
make debug SINGLE_THREADED=1
```

Useful for reproducing bugs that are deterministic single-threaded but hidden by scheduler timing in multi-threaded mode.

### ENABLE_DESER_DEBUG

Adds extra assertions during Deserializer reads (validates field names match expected names during checkpoint restore):

```bash
make debug ENABLE_DESER_DEBUG=1
```

Use when debugging checkpoint corruption or serialization format changes.

### Changing Database Internals Constants

These change the on-disk format and must match across build and test:

```bash
# Smaller node group size (useful for testing compaction/checkpoint on small datasets)
make debug NODE_GROUP_SIZE_LOG2=8    # 256 rows per group vs default 131072

# Smaller vector capacity (stress tests boundaries)
make debug VECTOR_CAPACITY_LOG2=8   # 256 rows per vector vs default 2048

# Smaller page size
make debug PAGE_SIZE_LOG2=10        # 1KB pages vs default 4KB
```

::: warning
These change the binary format. Tests compiled with different constants won't agree on expected output — only use with the corresponding test skip directives (`-SKIP_NODE_GROUP_SIZE_TESTS`, etc.) or a dedicated build directory.
:::

### In-Memory Mode

Tests can run against an in-memory database (no disk files):

```bash
IN_MEM_MODE=true make test
```

This is the default for unit tests that use `BaseGraphTest` without specifying a database path.

### Build Only What CI Will Test

```bash
# Reproduce CI: RelWithDebInfo + all tests
make test-build && make test

# Reproduce CI: Release + extension tests
make extension-test-build && make extension-test
```

### Profile Build Times

```bash
# Time the full build
time make relwithdebinfo

# Use Ninja's build log to find the slowest TUs
ninja -C build/relwithdebinfo -t restat
sort -k4 -rn build/relwithdebinfo/.ninja_log | head -20

# Or use ninjatracing for a Chrome trace
pip install ninjatracing
ninjatracing build/relwithdebinfo/.ninja_log > trace.json
# Open trace.json in chrome://tracing
```

## Related Files

- `CMakeLists.txt` — root CMake configuration
- `Makefile` — convenience wrappers
- `cmake/` — CMake modules (bundling, etc.)
- `docs/build_tips.md` — additional build tips
- `docs/cpp_style.md` — C++ coding style guide
- `AGENTS.md` — canonical build and test commands
