---
name: cluster-workflow-runner
description: "Effect @effect/cluster pattern for registering and launching workflows in a worker's main — toLayer, the provide stack (engine, runner, base deps), MainLayer via Layer.mergeAll, and Layer.launch under NodeRuntime.runMain. Use to build the standalone runner/worker process that consumes cluster workflow definitions and listens for work."
---

## When to use

When you have one or more workflow definitions and need a **standalone process** (the *runner* / worker node) that registers them with the cluster engine and listens for work. This is the `main` of your worker service.

The shape is always the same regardless of how many workflows you have:
1. one `RunnerLayer` (the cluster socket / sharding address),
2. one `BaseDependenciesLayer` (DB pool, HTTP client — shared by everyone),
3. **one layer per workflow**, each built the same way,
4. a single `MainLayer = Layer.mergeAll(...)`,
5. `Layer.launch(MainLayer)` under `NodeRuntime.runMain`.

## Procedure

1. **Runner address** — wrap `NodeClusterSocket.layer({ shardingConfig: { runnerAddress, runnerListenAddress } })` in `Layer.unwrapEffect(Effect.succeed(...))`. Pick a free port; `runnerListenAddress` is where this node binds.

2. **Base dependencies** — `Layer.mergeAll(PgLive, FetchHttpClient.layer)`. Everything shared by every workflow goes here so you provide it once per workflow layer instead of duplicating.

3. **One layer per workflow** — the canonical recipe:
   ```ts
   const XxxWorkflowLayer = XxxWorkFlow
     .toLayer(XxxWorkflowLogic)          // register the Logic adapter, NOT the handle alone
     .pipe(
       Layer.provide(XxxBusinessLogic.Default), // the service that implements run()
       Layer.provide(ClusterWorkflowEngine.layer),
       Layer.provide(RunnerLayer),
       Layer.provide(BaseDependenciesLayer)
     )
   ```
   - `toLayer` takes the **Logic adapter function** exported by the definition (`(payload, executionId) => Effect`), not the `Workflow.make` handle.
   - The provide order goes from **most specific → most generic**: the business logic, then the engine, then the runner, then the shared base.

4. **Workflows with their own service graph** — if the business logic itself needs deps (LLM client, several repos), build that service layer first and `Layer.provide` its pieces, then feed it into the workflow layer. Example: `ServiceNewSectorLlm.Default.pipe(Layer.provide(LlmSectorClient.Default), Layer.provide(EnrichmentRepository.Default), Layer.provide(BaseDependenciesLayer))`.

5. **Aggregate** — `const MainLayer = Layer.mergeAll(LayerA, LayerB, ...)`. **Every workflow layer must appear here.** A workflow not in `mergeAll` is compiled but never registered → it silently never runs.

6. **Launch** — run any startup side effects (e.g. a health server), then `Layer.launch(MainLayer)`:
   ```ts
   Effect.gen(function* () {
     yield* runHealthServer
     return yield* Layer.launch(MainLayer)
   }).pipe(NodeRuntime.runMain)
   ```
   `Layer.launch` keeps the process alive as long as the layers are running — that's what makes it a long-lived worker.

## Pitfalls

- **Forgetting to add the layer to `MainLayer`.** The single most common bug: you write `XxxWorkflowLayer`, it type-checks, but you never put it in `Layer.mergeAll`. The workflow is dead weight — triggers queue and nothing consumes them.
- **`toLayer` with the wrong argument.** Pass the `XxxWorkflowLogic` adapter, not the bare `Workflow.make` handle and not the business-logic class. The adapter is the `(payload, executionId) => Effect` function from cluster-workflow-definition.
- **Missing `ClusterWorkflowEngine.layer` or `RunnerLayer`.** Both must be provided to *each* workflow layer. Omitting the engine = no durability/dedup; omitting the runner = no address to receive work. Type errors here are noisy `R`-channel mismatches — read them as "a layer above me still needs X".
- **Provide order matters.** `Layer.provide` resolves bottom-up. Putting `BaseDependenciesLayer` before the service that consumes it leaves the service's requirements unsatisfied. Keep the specific→generic order shown above.
- **Naming drift (`WorkFlow` vs `Workflow`).** The codebase mixes `WorkFlow` and `Workflow` casing per workflow. Import the exact exported name — they are not interchangeable and the typo won't be auto-corrected.
- **One `RunnerLayer` / `BaseDependenciesLayer` instance, reused.** Define them once and reference them in every workflow layer. Don't re-create per workflow — you'd spin up redundant sockets/pools.
- **Health/readiness before launch.** Start the health server *inside* the `Effect.gen` before `Layer.launch`, so orchestrators (k8s) see the pod as alive while the cluster connects.

## Example

```ts
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { FetchHttpClient } from "@effect/platform"
import { PgLive } from "@template/database/Sql"
import { Effect, Layer, Option } from "effect"
import { runHealthServer } from "./Health/HttpServer.js"
import {
  CreateAdminEmailSendWorkflow,
  CreateAdminEmailSendWorkflowBussinessLogic,
  CreateAdminEmailSendWorkflowLogic
} from "@template/auth/workflow/mailing/CreateAdminEmailSendWorkflow"

// 1. Runner address (this node's socket)
const RunnerLayer = Layer.unwrapEffect(
  Effect.succeed(
    NodeClusterSocket.layer({
      shardingConfig: {
        runnerAddress: Option.some(RunnerAddress.make("0.0.0.0", 34431)),
        runnerListenAddress: Option.some(RunnerAddress.make("0.0.0.0", 34431))
      }
    })
  )
)

// 2. Shared deps — provided once per workflow layer
const BaseDependenciesLayer = Layer.mergeAll(PgLive, FetchHttpClient.layer)

// 3. One layer per workflow — canonical recipe
const CreateAdminEmailSendWorkflowLayer = CreateAdminEmailSendWorkflow
  .toLayer(CreateAdminEmailSendWorkflowLogic)        // the Logic adapter, not the handle
  .pipe(
    Layer.provide(CreateAdminEmailSendWorkflowBussinessLogic.Default), // implements run()
    Layer.provide(ClusterWorkflowEngine.layer),       // durability + idempotency
    Layer.provide(RunnerLayer),                        // this node's address
    Layer.provide(BaseDependenciesLayer)               // shared DB / HTTP
  )

// 4. A workflow whose service has its own graph: build the service layer first
const ServiceNewSectorLlmLayer = ServiceNewSectorLlm.Default.pipe(
  Layer.provide(LlmSectorClient.Default),
  Layer.provide(EnrichmentRepository.Default),
  Layer.provide(BaseDependenciesLayer)
)
const NewSectorLLMWorkflowLayer = NewsSectorLlmWorkFlow
  .toLayer(NewsSectorLlmWorker)
  .pipe(
    Layer.provide(ServiceNewSectorLlmLayer),
    Layer.provide(ClusterWorkflowEngine.layer),
    Layer.provide(RunnerLayer),
    Layer.provide(BaseDependenciesLayer)
  )

// 5. Aggregate — EVERY workflow layer must be listed here
const MainLayer = Layer.mergeAll(
  CreateAdminEmailSendWorkflowLayer,
  NewSectorLLMWorkflowLayer
  // ...every other workflow layer
)

// 6. Launch — health first, then keep the process alive
Effect.gen(function* () {
  yield* runHealthServer
  return yield* Layer.launch(MainLayer)
}).pipe(NodeRuntime.runMain)
```

## Related

- cluster-workflow-definition — where the `Workflow`, business logic and `Logic` adapter consumed here are defined
- effect-service — `XxxBusinessLogic.Default` is the self-contained service layer provided into each workflow
- http-server-live — same `Layer.launch` + `NodeRuntime.runMain` pattern for the HTTP entrypoint
