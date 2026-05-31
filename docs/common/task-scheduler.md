# Task Scheduler and Progress Tracking

This page documents LadybugDB's task system, worker-thread scheduler, processor task decomposition, and terminal progress bar integration.

## Scope and primary source files

- `src/include/common/task_system/task.h`
- `src/include/common/task_system/task_scheduler.h`
- `src/include/common/task_system/progress_bar.h`
- `src/include/common/task_system/progress_bar_display.h`
- `src/include/common/task_system/terminal_progress_bar_display.h`
- `src/common/task_system/task.cpp`
- `src/common/task_system/task_scheduler.cpp`
- `src/common/task_system/progress_bar.cpp`
- `src/common/task_system/terminal_progress_bar_display.cpp`
- `src/include/processor/processor.h`
- `src/processor/processor.cpp`
- `src/include/processor/processor_task.h`
- `src/processor/processor_task.cpp`
- `src/function/gds/gds_utils.cpp`
- `extension/algo/src/common/in_mem_gds_utils.cpp`
- `extension/algo/src/main/algo_extension.cpp`
- `src/main/database.cpp`
- `src/main/client_context.cpp`
- `src/main/settings.cpp`
- `src/processor/operator/physical_operator.cpp`

## High-level architecture

There are three distinct layers:

1. **Task abstraction**
   - `common::Task`
   - lifecycle, thread registration, exception storage, completion signaling

2. **Worker scheduler**
   - `common::TaskScheduler`
   - owns worker threads and the queue of scheduled tasks

3. **Query-specific integration**
   - `processor::QueryProcessor`
   - decomposes a physical plan into `ProcessorTask` objects
   - chooses single-threaded vs parallel execution per pipeline

A fourth supporting layer provides user-visible progress reporting:

4. **Progress tracking**
   - `ProgressBar`
   - `ProgressBarDisplay`
   - `TerminalProgressBarDisplay`

## Worker-thread count

The scheduler's worker-thread count is set when the database builds its `QueryProcessor`.
The path is:

- `SystemConfig.maxNumThreads`
- `DBConfig.maxNumThreads`
- `Database::initMembers()`
- `QueryProcessor(numThreads)`
- `TaskScheduler(numWorkerThreads)`

Important rules from `main/database.cpp`:

- if LadybugDB is compiled in normal multi-threaded mode and `maxNumThreads == 0`, it uses `std::thread::hardware_concurrency()`
- in `__SINGLE_THREADED__` builds, the configured thread count is ignored and forced to `1`

That number is the size of the scheduler's worker pool.
It is not necessarily the number of threads any individual task may use.

## Per-query thread count vs scheduler thread count

A second thread-count concept exists in `ClientContext` settings.
`ProcessorTask` is constructed with:

- `context->clientContext->getCurrentSetting(ThreadsSetting::name).getValue<uint64_t>()`

That value becomes the task's `maxNumThreads`.
So:

- scheduler pool size is database-wide infrastructure capacity
- task max threads is a query/session-level policy limit

Then `QueryProcessor::initTask()` may further reduce that limit to `1` if any operator in the pipeline reports `!isParallel()`.

## `Task`

`Task` is the abstract base class for schedulable work.

### Stored state

Key fields are:

- `Task* parent`
- `std::vector<std::shared_ptr<Task>> children`
- `std::mutex taskMtx`
- `std::condition_variable cv`
- `uint64_t maxNumThreads`
- `uint64_t numThreadsFinished`
- `uint64_t numThreadsRegistered`
- `std::exception_ptr exceptionsPtr`
- `uint64_t ID`

### Core virtual methods

Every subclass must implement:

- `run()`

Optional overrides:

- `finalize()`
- `terminate()`

`terminate()` defaults to `false` and is used by higher-level callers to stop scheduling dependent work after a task decides the overall workflow can end early.

### Important lifecycle semantics

The header comment is very explicit:

- a worker thread registers itself before calling `run()`
- the thread deregisters afterward
- if that thread is the last registered worker finishing the task, `finalize()` runs exactly once
- `finalize()` runs while the task lock is already held

That last point is extremely important for implementers.
The comment explicitly warns not to reacquire the task lock inside `finalize()`.

### Registration rules

`registerThread()` succeeds only if:

- the task has no stored exception
- `numThreadsFinished == 0`
- `maxNumThreads > numThreadsRegistered`

That means a task stops accepting new workers once any worker has finished.
This is a deliberate design choice that simplifies completion/finalization semantics.

### Completion rules

A task is considered complete when:

- `numThreadsRegistered > 0`
- `numThreadsFinished == numThreadsRegistered`

`deRegisterThreadAndFinalizeTask()`:

- increments `numThreadsFinished`
- runs `finalize()` exactly once if the task completed without an exception
- stores any `finalize()` exception in `exceptionsPtr`
- notifies all waiters once the task is complete

### Exception storage

The first exception wins.
`setExceptionNoLock()` only records an exception if `exceptionsPtr` is still null.
Later failures do not overwrite the first one.

## Task dependencies

`Task::addChildTask()` sets:

- `child->parent = this`
- appends the child into `children`

`TaskScheduler::scheduleTaskAndWaitOrError()` executes dependencies recursively before scheduling the current task.
The current implementation runs dependencies one after another, not concurrently with the parent.
The comment in the header states this explicitly.

## `TaskScheduler`

`TaskScheduler` owns:

- `taskQueue`
- `stopWorkerThreads`
- `workerThreads`
- `taskSchedulerMtx`
- `cv`
- `nextScheduledTaskID`
- macOS-only `threadQos`

### Construction and teardown

Construction:

- spawns `numWorkerThreads` threads immediately
- each thread runs `runWorkerThread()`

Destruction:

- sets `stopWorkerThreads = true`
- notifies all workers
- joins every worker thread

## Scheduling API

The main public entry point is:

- `scheduleTaskAndWaitOrError(task, context, launchNewWorkerThread=false)`

This function does the following in order:

1. recursively schedules child dependencies
2. stops early if a dependency's `terminate()` returns true
3. optionally launches an extra ad-hoc worker thread
4. pushes the task into the queue
5. wakes worker threads
6. waits on the task condition variable until completion or timeout/interrupt
7. joins the ad-hoc worker if one was launched
8. removes the task from the queue if it ended with an exception
9. rethrows the stored exception to the caller

## Why `launchNewWorkerThread` exists

This flag is used by graph-data-science code.
`gds_utils.cpp` explains the motivation directly:

- a GDS call can already be running on a scheduler worker thread
- if that worker now schedules a task and then blocks waiting for it, the effective worker pool shrinks by one
- in extreme cases, that can stall progress

So GDS paths call:

- `scheduleTaskAndWaitOrError(task, context, true)`

This pre-registers one extra worker and starts a new thread running `runTask(task.get())` so the waiting thread does not reduce total parallelism.

## Projected-graph algorithms are scheduler clients too

This scheduler is not only for relational/query pipelines.
The `algo` extension also uses it directly.

Two source-backed pieces make that clear:

- `AlgoExtension::load(...)` registers projected-graph algorithms including `PageRank`, `WCC`, `SCC`, `SCC_KO`, `KCoreDecomposition`, `Louvain`, and `SpanningForest`
- `extension/algo/src/common/in_mem_gds_utils.cpp` builds `InMemParallelComputeTask`, initializes a morsel dispatcher, and calls `TaskScheduler::Get(*clientContext)->scheduleTaskAndWaitOrError(task, context, true)`

That lines up with the public `docs.ladybugdb.com/extensions/algo/` docs, which describe `PageRank`, `WCC`, `SCC`, `K-Core`, and `Louvain` as algorithms that run on **projected graphs** created with `PROJECT_GRAPH(...)`.
Those public docs also say projected graphs are evaluated lazily and remain alive until dropped or the connection closes.

So the practical engineering picture is:

1. projected-graph metadata lives above the scheduler
2. algorithm execution fans out into scheduler tasks only when the algorithm actually runs
3. the extra-worker path is especially important here because graph algorithms can invoke parallel work while already executing inside the engine

## Queue behavior

Internally, scheduled work is wrapped in `ScheduledTask`:

- `std::shared_ptr<Task> task`
- `uint64_t ID`

Tasks are appended to the back of a deque.
Workers scan from the front.

The queue is therefore FIFO in **registration opportunity** order, but not in **completion** order.
The header comment says this explicitly.
A long-running task that has already filled its registration quota can remain near the front while younger tasks complete first.

## `getTaskAndRegister()`

This is the key queue-selection function.

Algorithm:

1. if the queue is empty, return null
2. scan from front to back
3. call `task->registerThread()` on each candidate
4. if registration fails:
   - erase the task if it is completed successfully
   - otherwise keep it in the queue
5. return the first task that accepts the current worker

Important implication:

- completed-successful tasks are removed lazily by workers during later scans
- erroring tasks stay in the queue until explicitly removed by `removeErroringTask()`

## Exception propagation and interrupt behavior

Worker threads catch exceptions raised by `task->run()` and keep them in a local `exceptionPtr` until they reacquire the global scheduler lock.
Then they store that exception into the task before deregistration.

The waiting thread in `scheduleTaskAndWaitOrError()` reacts as follows:

- if the client context has a timeout, it waits only for the remaining timeout duration
- if timeout reaches zero, it interrupts the client context
- if the task already has an exception, it interrupts the client context so peer workers can stop earlier
- once the task completes, it rethrows the stored exception

## Memory-ordering / visibility guarantee

The most important concurrency comment in this subsystem is inside `runWorkerThread()`.

The design intentionally acquires the **global scheduler mutex** immediately before deregistering from a finished task, and then keeps that ordering relationship with subsequent task registration.
The comment explains the purpose:

- all writes performed by workers on `Task_j` become globally visible before any worker can begin `Task_{j+1}` that depends on `Task_j`

This is a scheduler-level happens-before guarantee built from the global lock discipline.
It is central to the dependency model.

## Worker loop

The multi-threaded worker loop does this repeatedly:

1. lock scheduler mutex
2. if it just finished a task:
   - store any pending exception into the task
   - deregister and finalize if needed
3. wait until either:
   - a task can be registered
   - shutdown is requested
4. unlock scheduler mutex
5. run the task body outside the lock
6. repeat

That design keeps actual task execution off the global scheduler mutex while still using the mutex for queue selection and dependency-ordering guarantees.

## Single-threaded build variant

When `__SINGLE_THREADED__` is enabled:

- no worker threads are created
- `scheduleTaskAndWaitOrError()` executes dependencies recursively in the caller thread
- `runTask(task.get())` is called directly
- timeout checks move into `PhysicalOperator::getNextTuple()` because the main thread is blocked during execution

This is not just a compile-time optimization.
The code genuinely has a separate single-thread scheduler implementation.

## Query processor integration

`QueryProcessor::execute()` is the main database-side caller.

### Execution flow

It:

1. registers query start on the client context
2. creates a root `ProcessorTask` from the plan sink
3. decomposes the physical plan into a task tree
4. calls `initTask()` on the root
5. starts progress tracking
6. schedules the root task on the scheduler
7. ends progress tracking
8. returns the sink's `QueryResult`

### Task decomposition

`decomposePlanIntoTask()` walks the physical plan.
Important rules:

- if an operator is a source, the progress bar records one pipeline via `addPipeline()`
- if an operator is a sink, a new child `ProcessorTask` is created
- for non-sink operators, children are traversed right-to-left
- the comment explicitly says the right-most side is scheduled first, e.g. the build side of a hash join

So the task tree reflects pipeline boundaries, not every individual operator.

### Parallelism downgrades

`initTask()` scans the sink-side linear pipeline until it reaches a source.
If any operator in that chain is not parallel, it calls `task->setSingleThreadedTask()`.
Then it recursively does the same for child tasks.

This means:

- scheduler pool size may be large
- client thread setting may allow many threads
- but any individual pipeline can still be forced to one thread by operator capabilities

## `ProcessorTask`

`ProcessorTask` is the concrete task subclass used for query execution pipelines.

### Construction

It initializes the base `Task` with the current `ThreadsSetting` value from the client context.
So max parallelism is determined at task creation time.

### `run()` behavior

`run()` does three important things:

1. acquires the task mutex to guard non-thread-safe cloning/initialization
2. lazily initializes sink global state once
3. clones the sink subtree and runs the copied pipeline with a fresh `ResultSet`

The source comment says cloning is protected because multiple threads can reach that path concurrently and the clone operation is not thread-safe.

### `finalize()` behavior

`finalize()` does exactly two things:

- marks one pipeline finished in the progress bar
- calls `sink->finalize(executionContext)`

This is why the base `Task` finalization guarantee matters so much.
It ensures sink finalization happens once per pipeline task.

### `terminate()` behavior

Delegates to `sink->terminate()`.
This lets a sink-driven termination condition prune higher-level scheduling.

## Progress tracking

The progress subsystem is deliberately separate from the scheduler.
The scheduler executes work.
Operators and processor tasks report progress.

## `ProgressBarDisplay`

This is the display interface.
It stores:

- atomic `pipelineProgress`
- `numPipelines`
- atomic `numPipelinesFinished`

Virtual methods:

- `updateProgress(queryID, newPipelineProgress, newNumPipelinesFinished)`
- `finishProgress(queryID)`

The interface is designed to support asynchronous multi-query environments via `queryID`, even though the default terminal display currently ignores it.

## `ProgressBar`

`ProgressBar` is the query-local controller.
It stores:

- `numPipelines`
- `numPipelinesFinished`
- `progressBarLock`
- `trackProgress`
- `display`

### Important methods

- `startProgress(queryID)`
- `endProgress(queryID)`
- `addPipeline()`
- `finishPipeline(queryID)`
- `updateProgress(queryID, currentPipelineProgress)`
- `toggleProgressBarPrinting(enable)`
- `setDisplay(...)`

### Reset behavior

`endProgress()` locks the controller and calls `resetProgressBar(queryID)`.
Resetting clears:

- pipeline count
- finished count
- display state through `finishProgress(queryID)`

## `TerminalProgressBarDisplay`

The default display prints to the terminal using ANSI cursor movement and color codes.

### Rendering behavior

On each accepted update it prints:

- `Pipelines Finished: X/Y`
- `Current Pipeline Progress: Z%`

It uses:

- green font while printing
- cursor-up / clear-line escape sequences to overwrite prior output

### Concurrency strategy

This class intentionally accepts some display races.
The source comment says:

- the comparison and update are not fully atomic together
- the displayed value does not need perfect accuracy
- atomics are used instead of mutexes for performance

A separate atomic flag `currentlyPrintingProgress` suppresses overlapping prints from different threads.
If another thread is already printing, the current update is skipped.

## Where progress updates come from

The main execution-time update path is in `PhysicalOperator::getNextTuple()`.
After `getNextTuplesInternal(context)` returns, the operator calls:

- `ProgressBar::Get(*context->clientContext)->updateProgress(context->queryID, getProgress(context))`

So progress is driven by operator polling, not by scheduler timestamps.

Pipeline completion updates come from `ProcessorTask::finalize()` via `finishPipeline(queryID)`.

## Relevant settings

The user-visible settings layer hooks into this subsystem.

- `ThreadsSetting`
  - controls per-query max threads for processor tasks
- progress-bar setting in `settings.cpp`
  - toggles `ProgressBar::toggleProgressBarPrinting(...)`

These settings are query/session scoped through `ClientContext`.

## Practical debugging notes

### If a task never finalizes

Check:

- whether any worker actually registered
- whether `numThreadsFinished` can catch up to `numThreadsRegistered`
- whether a worker threw before deregistration
- whether a task is stuck in the queue because it errored and was never removed by the waiting thread

### If dependencies appear to race

Read the long comment in `runWorkerThread()` first.
The scheduler is explicitly designed to publish writes through the global scheduler mutex before dependent work begins.

### If query progress looks wrong

Check three places:

1. `QueryProcessor::decomposePlanIntoTask()` for pipeline counting
2. `PhysicalOperator::getNextTuple()` for update frequency
3. `ProcessorTask::finalize()` for finished-pipeline accounting

### If GDS stalls with low thread counts

Look for callers that forgot to pass `launchNewWorkerThread=true` when scheduling sub-work from an already-running scheduler worker.
`gds_utils.cpp` exists largely to explain that exact issue.

## Summary

The scheduler is intentionally small but opinionated:

- tasks can accept multiple workers, but only until the first worker starts finishing
- dependencies are executed recursively and ordered by scheduler-lock handoff
- errors propagate through stored exceptions and client-context interrupts
- processor tasks map pipelines, not arbitrary operator fragments
- progress tracking is cooperative and operator-driven

For execution bugs, read `task_scheduler.cpp` and `processor.cpp` together.
For user-visible responsiveness issues, add `processor_task.cpp`, `physical_operator.cpp`, and the progress-bar files.
