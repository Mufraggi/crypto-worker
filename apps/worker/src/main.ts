import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { FetchHttpClient } from "@effect/platform"
import { NodeClusterSocket, NodeRuntime } from "@effect/platform-node"
import { CoinGeckoMigrations } from "@template/database/CoinGeckoMigrations"
import { PgLive } from "@template/database/Sql"
import {
  CoinEnrichWorkflow,
  CoinEnrichWorkflowBusinessLogic,
  CoinEnrichWorkflowLogic
} from "@template/workflow/coingecko/CoinEnrichWorkflow"
import {
  PriceSnapshotWorkflow,
  PriceSnapshotWorkflowBusinessLogic,
  PriceSnapshotWorkflowLogic
} from "@template/workflow/coingecko/PriceSnapshotWorkflow"
import { Effect, Layer, Option, Ref, Schedule } from "effect"
import { randomUUID } from "node:crypto"
import { runHealthServer } from "./Health/HttpServer.js"

// ── Shared base layers ───────────────────────────────────────────────────────
// These three are referenced (by identity) in several places below. Effect memoizes a layer
// per build graph, so referencing the SAME value everywhere yields ONE runner socket, ONE
// engine and ONE Postgres pool — never duplicates.

const RunnerLayer = NodeClusterSocket.layer({
  shardingConfig: {
    runnerAddress: Option.some(RunnerAddress.make("0.0.0.0", 34431)),
    runnerListenAddress: Option.some(RunnerAddress.make("0.0.0.0", 34431))
  }
})

const BaseDependenciesLayer = Layer.mergeAll(PgLive, FetchHttpClient.layer)

const ClusterEngineLayer = ClusterWorkflowEngine.layer

// ── One layer per workflow (canonical recipe, specific → generic) ────────────

const PriceSnapshotWorkflowLayer = PriceSnapshotWorkflow.toLayer(PriceSnapshotWorkflowLogic).pipe(
  Layer.provide(PriceSnapshotWorkflowBusinessLogic.Default),
  Layer.provide(ClusterEngineLayer),
  Layer.provide(RunnerLayer),
  Layer.provide(BaseDependenciesLayer)
)

const CoinEnrichWorkflowLayer = CoinEnrichWorkflow.toLayer(CoinEnrichWorkflowLogic).pipe(
  Layer.provide(CoinEnrichWorkflowBusinessLogic.Default),
  Layer.provide(ClusterEngineLayer),
  Layer.provide(RunnerLayer),
  Layer.provide(BaseDependenciesLayer)
)

// The workflow layers above *consume* the engine to register their handlers but do not
// re-expose it. The in-process scheduler (below) needs `WorkflowEngine` to call `.execute`,
// so expose a fully-provided engine built from the SAME RunnerLayer/Base values → memoized to
// the very same runner the handlers registered on.
const SchedulerEngineLayer = ClusterEngineLayer.pipe(
  Layer.provide(RunnerLayer),
  Layer.provide(BaseDependenciesLayer)
)

// ── Aggregate — every workflow layer + the engine/base the program itself needs ──
const MainLayer = Layer.mergeAll(
  PriceSnapshotWorkflowLayer,
  CoinEnrichWorkflowLayer,
  SchedulerEngineLayer,
  BaseDependenciesLayer
)

// ── Scheduler ────────────────────────────────────────────────────────────────

const TOP_20_COINS = [
  "bitcoin",
  "ethereum",
  "tether",
  "bnb",
  "solana",
  "usdc",
  "xrp",
  "dogecoin",
  "cardano",
  "avalanche-2",
  "shiba-inu",
  "polkadot",
  "chainlink",
  "uniswap",
  "litecoin",
  "bitcoin-cash",
  "stellar",
  "aptos",
  "near",
  "matic-network"
]

const scheduler = Effect.gen(function*() {
  const indexRef = yield* Ref.make(0)

  const priceSnapshotLoop = Effect.repeat(
    // Generate a fresh runId PER ITERATION. If randomUUID() is called once when the Effect is
    // built, every repeat reuses the same idempotencyKey and the cluster dedupes to the first
    // run — so the snapshot would only ever execute once.
    Effect.gen(function*() {
      const runId = randomUUID()
      yield* PriceSnapshotWorkflow.execute({ runId }).pipe(
        Effect.catchAll((error) => Effect.logError(`PriceSnapshotWorkflow failed: ${error}`))
      )
    }),
    Schedule.spaced("10 seconds")
  )

  const coinEnrichLoop = Effect.repeat(
    Effect.gen(function*() {
      const i = yield* Ref.getAndUpdate(indexRef, (n) => (n + 1) % 20)
      // Fresh tick per iteration → fresh idempotencyKey → the coin is re-enriched every tick.
      const tick = new Date().toISOString()
      yield* CoinEnrichWorkflow.execute({ coinId: TOP_20_COINS[i], tick }).pipe(
        Effect.catchAll((error) => Effect.logError(`CoinEnrichWorkflow failed: ${error}`))
      )
    }),
    Schedule.spaced("1 minutes")
  )

  yield* Effect.all([priceSnapshotLoop, coinEnrichLoop], { concurrency: "unbounded" })
})

// ── Program ──────────────────────────────────────────────────────────────────

const program = Effect.gen(function*() {
  yield* runHealthServer

  // Create the demo tables before anything triggers a workflow.
  yield* CoinGeckoMigrations

  // Start the background scheduler against the live cluster engine.
  yield* scheduler.pipe(Effect.forkDaemon)

  // Keep the process (and the registered workflow handlers) alive.
  return yield* Effect.never
})

program.pipe(Effect.provide(MainLayer), NodeRuntime.runMain)
