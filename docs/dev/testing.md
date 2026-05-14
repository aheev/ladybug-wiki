# Testing Guide

**Source files:** `test/`, `test/test_runner/`, `test/test_files/`, `docs/testing.md`, `AGENTS.md`

## Test Categories

| Directory | Type | Description |
|-----------|------|-------------|
| `test/runner/` | E2E | End-to-end `.test` file runner — the primary test type |
| `test/api/` | C++ gtest | High-level API tests (Connection, QueryResult, Arrow, UDF) |
| `test/storage/` | C++ gtest | Storage layer unit tests |
| `test/transaction/` | C++ gtest | Transaction, WAL, checkpoint unit tests |
| `test/binder/` | C++ gtest | Binder error/type checking tests |
| `test/planner/` | C++ gtest | Logical plan structure tests |
| `test/optimizer/` | C++ gtest | Optimizer rule tests |
| `test/copy/` | C++ gtest | COPY/import tests |
| `test/common/` | C++ gtest | Primitive type unit tests (date, string, null mask, …) |

## Building and Running Tests

```bash
# Build test binaries (RelWithDebInfo — stack traces available)
make test-build

# Run all tests
make test

# Build + run in one step (Release — faster to build)
make test-build-release && make test

# Language-specific test suites
make pytest        # Python API
make javatest      # Java API
make nodejstest    # Node.js API
make rusttest      # Rust API
make wasmtest      # WASM

# Extension tests
make extension-test-build && make extension-test
```

## Running Specific Tests

```bash
# Run by gtest filter (matches test name by glob)
build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*match~one_hop*"

# E2E tests are named by their file path with / replaced by ~
# File: test/test_files/match/one_hop.test
# GTest name: match~one_hop.<CaseName>

# Run a single C++ unit test
build/relwithdebinfo/test/transaction/transaction_test \
  --gtest_filter="TransactionTest.CommitAndRollback"

# Run all transaction tests
build/relwithdebinfo/test/transaction/transaction_test
```

## E2E Test File Format (`.test`)

End-to-end tests live in `test/test_files/` as plain text `.test` files. They are parsed by `test/test_runner/test_parser.cpp` and executed by `test/test_runner/test_runner.cpp`.

### File Header

Every test file begins with a header section (before `--`):

```
-DATASET CSV tinysnb     ← dataset type and name to load before any test case
--                       ← separator: header ends here
```

Dataset types: `CSV`, `PARQUET`, `NPY`, `LBUG`, `JSON`, `ICEBUG-DISK`, `CSV_TO_PARQUET(name)`, `CSV_TO_JSON(name)`

Dataset names refer to directories under `dataset/`.

### Test Cases

After the `--` separator, the file contains one or more test cases:

```
-CASE MatchOneHop            ← test case name (maps to gtest test name)

-LOG OneHopKnowsTest         ← log label (shown in gtest output on failure)
-STATEMENT MATCH (a:person)-[e:knows]->(b:person) RETURN COUNT(*)
---- 1                       ← expected: 1 result row
14                           ← expected row value

-LOG FilterAge
-STATEMENT MATCH (p:person) WHERE p.age > 35 RETURN p.fName ORDER BY p.fName
---- 3
Alice
Bob
Carol
```

### Result Format

```
---- N        ← expect N result rows
row1          ← expected rows, one per line
row2
...
```

Special result markers:

```
---- ok       ← query should succeed (returns no rows or is a DDL/DML)
---- error    ← query should throw an exception (next line is error message prefix)
Binder exception: Table foo does not exist.
```

Row values use `|` as column delimiter for multi-column results:

```
-STATEMENT MATCH (p:person) RETURN p.fName, p.age ORDER BY p.fName
---- 2
Alice|30
Bob|45
```

### Statement Options

```
-STATEMENT BEGIN TRANSACTION;
---- ok
-STATEMENT CREATE (:person {id: 1, name: "Alice"})
---- ok
-STATEMENT COMMIT;
---- ok
```

### Recovery Tests: `-RELOADDB`

`-RELOADDB` closes and reopens the database (simulates crash recovery). Used in transaction and WAL recovery tests:

```
-STATEMENT CALL auto_checkpoint=false
---- ok
-STATEMENT CREATE (:person {id: 1, name: "Alice"})
---- ok
-RELOADDB                    ← database is closed and reopened from disk
-STATEMENT MATCH (p:person) RETURN p.name
---- 1
Alice                        ← must survive reload (WAL was replayed)
```

### Concurrent Execution

```
-BEGIN_CONCURRENT_EXECUTION 4        ← start 4 parallel threads
-STATEMENT MATCH (p:person) RETURN COUNT(*)
-STATEMENT MATCH (p:person) RETURN COUNT(*)
-END_CONCURRENT_EXECUTION
```

### Skip Directives (Header)

```
-SKIP                        ← always skip
-SKIP_IN_MEM                 ← skip when IN_MEM_MODE=true
-SKIP_WASM                   ← skip on WASM target
-SKIP_MUSL                   ← skip when compiled with musl libc
-SKIP_COMPRESSION_DISABLED   ← skip when ENABLE_COMPRESSION=false
-SKIP_VECTOR_CAPACITY_TESTS  ← skip unless vector capacity = standard (2048)
-SKIP_NODE_GROUP_SIZE_TESTS  ← skip unless node group size = standard (131072)
-SKIP_PAGE_SIZE_TESTS        ← skip unless page size = standard (4KB)
```

### Utility Directives

```
-SET checkpointing_interval=100   ← set a system config value
-CREATE_CONNECTION conn2          ← create a named connection
-STATEMENT [conn2] MATCH ...      ← run on a specific connection
-REMOVE_FILE /path/to/file        ← delete a file
-IMPORT_DATABASE /path/to/db      ← import a Lbug database
-CHECK_ORDER                      ← enforce result row order
-CHECK_PRECISION                  ← enable float comparison with ULP tolerance
```

### Environment Variables for Test Runs

| Variable | Effect |
|----------|--------|
| `IN_MEM_MODE=true` | Use an in-memory database |
| `ENABLE_COMPRESSION=false` | Disable column compression |
| `E2E_TEST_FILES_DIRECTORY=path` | Override test file root (default: `test/test_files/`) |
| `KUZU_NUM_THREADS=1` | Force single-threaded execution |

## Writing a C++ Unit Test

```cpp
#include "test_helper/test_helper.h"
#include <gtest/gtest.h>

namespace lbug {
namespace testing {

class MyStorageTest : public DBTest {
    // DBTest creates an in-memory database and a default Connection
    std::string getInputDir() override {
        return TestHelper::appendLbugRootPath("dataset/tinysnb/");
    }
};

TEST_F(MyStorageTest, BasicScan) {
    auto result = conn->query("MATCH (p:person) RETURN COUNT(*)");
    ASSERT_TRUE(result->isSuccess());
    ASSERT_EQ(result->getNumTuples(), 1);
    result->getNext();
    EXPECT_EQ(result->getValue<int64_t>(0), 8);
}

} // namespace testing
} // namespace lbug
```

Key base classes:

| Class | Description |
|-------|-------------|
| `DBTest` | In-memory database + single connection |
| `BaseGraphTest` | Base for graph tests; subclass and override `getInputDir()` |
| `TestHelper` | Static helpers: `executeScript()`, `appendLbugRootPath()`, dataset paths |

## Writing a `.test` File

1. Create `test/test_files/<category>/<name>.test`
2. Add the header (`-DATASET ...` + `--`)
3. Add test cases with `-CASE`, `-LOG`, `-STATEMENT`, and expected results
4. Run: `build/relwithdebinfo/test/runner/e2e_test --gtest_filter="*<category>~<name>*"`

### Updating Expected Results

If you change query output, run the test with `UPDATE_RESULTS=1` to regenerate expected results:

```bash
UPDATE_RESULTS=1 build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*match~one_hop*"
```

## Test Datasets

Test datasets live in `dataset/`. Each dataset directory contains:
- `schema.cypher` — `CREATE TABLE` statements
- `copy.cypher` — `COPY FROM` statements to load data

The primary test dataset is `tinysnb` — a small graph with `person`, `organisation`, `knows`, `workAt`, `studyAt` tables. Most unit tests use `tinysnb`.

Large-scale tests (LDBC SF0.1, LSQB) are in `dataset/ldbc-sf01/` and `dataset/lsqb-sf01/` and are only run on CI with sufficient memory.

## Parallel Test Execution

Tests run in parallel across files. The number of parallel jobs is controlled by `TEST_JOBS` (default: 10):

```bash
make test TEST_JOBS=4    # Run with 4 parallel test executables
```

Individual test executables use `gtest-parallel` or the gtest built-in `--gtest_repeat` for parameterized repeats.

## Tips & Tricks

### Run Only the Tests You Changed

```bash
# E2E test name = file path with / → ~
# test/test_files/transaction/recovery.test → filter "*transaction~recovery*"
build/relwithdebinfo/test/runner/e2e_test --gtest_filter="*transaction~recovery*"

# Glob works too — match all optimizer tests
build/relwithdebinfo/test/runner/e2e_test --gtest_filter="*optimizer~*"

# Unit test by exact case name
build/relwithdebinfo/test/transaction/transaction_test \
  --gtest_filter="TransactionTest.CommitAndRollback"
```

### Parallel Test Execution

Tests run via `ctest` with `TEST_JOBS=10` by default (10 test executables in parallel):

```bash
# Increase parallel jobs for faster CI-like runs
make test TEST_JOBS=20

# Decrease to avoid resource contention on a shared machine
make test TEST_JOBS=4

# Run ctest directly for more control
ctest --test-dir build/relwithdebinfo/test \
  --output-on-failure \
  -j 16 \
  -R "transaction"    # only tests whose name matches regex
```

### Force Single-Threaded Execution

Use `KUZU_NUM_THREADS=1` to serialize query execution — removes any non-determinism from the task scheduler. Invaluable for reproducing bugs that disappear with parallelism:

```bash
KUZU_NUM_THREADS=1 build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*my_flaky_test*"
```

### Detect Flaky Tests

Repeat a test many times to expose timing-sensitive failures:

```bash
build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*concurrent*" \
  --gtest_repeat=50 \
  --gtest_break_on_failure   # stop at first failure
```

### Debug a Failing Test with GDB

```bash
# Build debug version (assertions + debug symbols)
make test-build   # uses RelWithDebInfo by default

# Drop into GDB on the first test failure
gdb --args build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*my_failing_test*" \
  --gtest_break_on_failure

# Inside GDB: common workflow
(gdb) run
# ... fails and drops into debugger ...
(gdb) bt          # backtrace
(gdb) frame 3     # jump to frame
(gdb) p variable  # print value
(gdb) watch expr  # set watchpoint
```

### Run Tests Under AddressSanitizer

```bash
# Build with ASAN (adds ~2× slowdown)
make test-build ASAN=1

# Run — ASAN will report heap overflows, use-after-free, etc.
build/asan/relwithdebinfo/test/runner/e2e_test --gtest_filter="*storage*"
```

For thread safety bugs, use Thread Sanitizer:

```bash
make test-build TSAN=1
build/tsan/relwithdebinfo/test/runner/e2e_test --gtest_filter="*concurrent*"
```

::: tip
Run ASAN/TSAN builds in `test-build` mode (not `debug`) — debug is too slow with sanitizers. RelWithDebInfo + sanitizer gives readable stack traces without being painful.
:::

### Verbose Test Output

```bash
# Print all test names as they run
build/relwithdebinfo/test/runner/e2e_test --gtest_list_tests

# Verbose output (shows PASSED/FAILED for each individual test case)
build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*storage*" \
  --gtest_print_time=1

# ctest verbose mode (shows stdout for ALL tests, not just failures)
ctest --test-dir build/relwithdebinfo/test -VV -R "storage"
```

### Isolate In-Memory vs On-Disk Behavior

```bash
# Force in-memory (no WAL, no checkpoint, fastest)
IN_MEM_MODE=true build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*match*"

# Force on-disk (tests WAL replay, crash recovery)
# Don't set IN_MEM_MODE — it defaults to disk mode for e2e tests
```

Tests decorated with `-SKIP_IN_MEM` are explicitly excluded from in-memory runs.

### Test a Reload / Recovery Scenario

Use `-RELOADDB` in `.test` files to simulate crash-and-recovery without writing C++. For one-off interactive testing, use the shell:

```bash
build/relwithdebinfo/tools/shell/lbug /tmp/testdb
```

```cypher
-- Session 1: write data, close shell (Ctrl-D)
CREATE (:person {id: 1, name: 'Alice'});
-- Session 2: reopen and verify WAL was replayed
MATCH (p:person) RETURN p.name;
```

### Disable Compression for Simpler Debugging

```bash
ENABLE_COMPRESSION=false build/relwithdebinfo/test/runner/e2e_test \
  --gtest_filter="*storage*"
```

All data stored uncompressed — makes it easier to inspect raw column chunk bytes with a hex editor.

### List All Available Test Files

```bash
find test/test_files -name "*.test" | sort

# Count test cases in a directory
grep -c "^-CASE" test/test_files/transaction/*.test
```

### ctest Regex Filtering

```bash
# Run only tests matching a pattern
ctest --test-dir build/relwithdebinfo/test -R "optimizer" --output-on-failure

# Exclude tests matching a pattern
ctest --test-dir build/relwithdebinfo/test -E "ldbc|lsqb" --output-on-failure

# List all registered ctest tests without running them
ctest --test-dir build/relwithdebinfo/test -N
```

## Related Files

- `test/test_runner/test_parser.cpp` — `.test` file tokenizer and parser
- `test/test_runner/test_runner.cpp` — test executor, result comparison
- `test/graph_test/base_graph_test.h` — base class for gtest-based graph tests
- `test/test_helper/test_helper.h` — static helpers, path utilities
- `docs/testing.md` — brief testing overview in the repo
