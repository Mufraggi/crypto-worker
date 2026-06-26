import { Activity, Workflow } from "@effect/workflow"
import { Effect, pipe, Schedule, Schema } from "effect"
import { CoinGeckoClient } from "./CoinGeckoClient.js"
import { CoinGeckoRepository } from "./CoinGeckoRepository.js"
import { CoinMarket } from "./CoinGeckoSchemas.js"

/**
 * PriceSnapshotWorkflow — captures a snapshot of the top coin prices from CoinGecko and
 * persists them into demo_price_snapshots. Bundles the tagged error, the durable handle, the
 * business logic and the Activity-based logic adapter.
 *
 * 1. Tagged error — propagated on the workflow error channel (cluster handles retry/dedup).
 */
export class PriceSnapshotWorkflowError extends Schema.TaggedError<PriceSnapshotWorkflowError>()(
  "PriceSnapshotWorkflowError",
  { message: Schema.String }
) {}

// 2. Durable handle — captures a snapshot of top coin prices into demo_price_snapshots.
export const PriceSnapshotWorkflow = Workflow.make({
  name: "PriceSnapshotWorkflow",
  payload: Schema.Struct({ runId: Schema.String }),
  idempotencyKey: (payload: { runId: string }) => payload.runId,
  success: Schema.Void,
  error: PriceSnapshotWorkflowError
})

// Throttle (public rate limit 30 req/min) + bounded exponential retry on transient failures.
const fetchSchedule = Schedule.exponential("2 seconds").pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.recurs(5))
)

// 3. Business logic — granular steps, one per durable Activity. Each stays pure domain + typed
//    errors (client/repo captured in the closure), so its R is `never`.
export class PriceSnapshotWorkflowBusinessLogic extends Effect.Service<PriceSnapshotWorkflowBusinessLogic>()(
  "PriceSnapshotWorkflowBusinessLogic",
  {
    effect: Effect.gen(function*() {
      const client = yield* CoinGeckoClient
      const repo = yield* CoinGeckoRepository

      return {
        fetchMarkets: pipe(
          client.getMarkets,
          Effect.delay("2 seconds"),
          Effect.retry(fetchSchedule),
          Effect.mapError((error) => new PriceSnapshotWorkflowError({ message: `fetchMarkets failed: ${error}` }))
        ),
        persistSnapshots: (runId: string, markets: ReadonlyArray<CoinMarket>) =>
          repo.insertPriceSnapshots(
            markets.map((m) => ({
              runId,
              coinId: m.id,
              symbol: m.symbol,
              name: m.name,
              currentPrice: m.currentPrice,
              marketCap: m.marketCap,
              priceChangePct: m.priceChangePercentage24h
            }))
          )
      }
    }),
    dependencies: [CoinGeckoClient.Default, CoinGeckoRepository.Default]
  }
) {}

// 4. Logic adapter — registered by the runner via Workflow.toLayer(...). Each step is wrapped in
//    Activity.make so its result is journaled: on resume, a completed fetch is NOT re-run (no
//    wasted CoinGecko call) and only the failed step retries.
export const PriceSnapshotWorkflowLogic = (
  payload: { readonly runId: string },
  executionId: string
) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(`▶ PriceSnapshot start runId=${payload.runId} (exec ${executionId})`)
    const logic = yield* PriceSnapshotWorkflowBusinessLogic

    const markets = yield* Activity.make({
      name: "fetchMarkets",
      success: Schema.Array(CoinMarket),
      error: PriceSnapshotWorkflowError,
      execute: logic.fetchMarkets
    })

    yield* Effect.logInfo(`  PriceSnapshot fetched ${markets.length} markets, persisting…`)
    yield* Activity.make({
      name: "persistSnapshots",
      execute: logic.persistSnapshots(payload.runId, markets)
    })
    yield* Effect.logInfo(`✔ PriceSnapshot done runId=${payload.runId} (${markets.length} rows)`)
  })
