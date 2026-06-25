import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster"
import { FetchHttpClient } from "@effect/platform"
import { NodeClusterSocket } from "@effect/platform-node"
import { CoinGeckoMigrations } from "@template/database/CoinGeckoMigrations"
import { PgLive } from "@template/database/Sql"
import {
  CoinEnrichWorker,
  CoinEnrichWorkflow,
  CoinGeckoClientLive,
  PriceSnapshotWorker,
  PriceSnapshotWorkflow
} from "@template/workflow"
import { Effect, Layer, ManagedRuntime, Option, Ref, Schedule } from "effect"
import { randomUUID } from "node:crypto"
import { runHealthServer } from "./Health/HttpServer.js"

// ── Base layers ──────────────────────────────────────────────────────────────

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

const BaseDependenciesLayer = Layer.mergeAll(PgLive, FetchHttpClient.layer)

const ClusterEngineLayer = ClusterWorkflowEngine.layer

// ── Fully wired application layer ──────────────────────────────────────────

// Build a fully self-contained layer by wiring deps via Layer.provide
const FullLayer: Layer.Layer<never, never, never> = Layer.mergeAll(
  BaseDependenciesLayer,
  CoinGeckoClientLive,
  ClusterEngineLayer.pipe(
    Layer.provide(RunnerLayer.pipe(
      Layer.provide(BaseDependenciesLayer)
    ))
  ),
  PriceSnapshotWorkflow.toLayer(PriceSnapshotWorker).pipe(
    Layer.provide(CoinGeckoClientLive),
    Layer.provide(ClusterEngineLayer),
    Layer.provide(RunnerLayer),
    Layer.provide(BaseDependenciesLayer)
  ),
  CoinEnrichWorkflow.toLayer(CoinEnrichWorker).pipe(
    Layer.provide(CoinGeckoClientLive),
    Layer.provide(ClusterEngineLayer),
    Layer.provide(RunnerLayer),
    Layer.provide(BaseDependenciesLayer)
  )
) as unknown as Layer.Layer<never, never, never>

// ── Runtime ─────────────────────────────────────────────────────────────────

const runtime = ManagedRuntime.make(FullLayer)

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
    PriceSnapshotWorkflow.execute({ runId: randomUUID() }),
    Schedule.spaced("5 minutes")
  )

  const coinEnrichLoop = Effect.repeat(
    Effect.gen(function*() {
      const i = yield* Ref.getAndUpdate(indexRef, (n) => (n + 1) % 20)
      yield* CoinEnrichWorkflow.execute({ coinId: TOP_20_COINS[i] })
    }),
    Schedule.spaced("10 minutes")
  )

  yield* Effect.all([priceSnapshotLoop, coinEnrichLoop], { concurrency: "unbounded" })
})

// ── Program ──────────────────────────────────────────────────────────────────

const program: Effect.Effect<void, never, never> = Effect.gen(function*() {
  yield* runHealthServer

  // Create tables before anything else
  yield* CoinGeckoMigrations

  // Start the background scheduler
  yield* scheduler.pipe(Effect.forkDaemon)

  // Keep process alive
  yield* Effect.never
}) as unknown as Effect.Effect<void, never, never>

// Run the program using the managed runtime
runtime.runFork(program)
