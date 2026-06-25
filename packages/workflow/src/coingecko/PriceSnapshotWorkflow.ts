import { Workflow } from "@effect/workflow"
import { Effect, pipe, Schedule, Schema } from "effect"
import { CoinGeckoClient } from "./CoinGeckoClient.js"
import { CoinGeckoRepository } from "./CoinGeckoRepository.js"

// 1. Tagged error — propagated on the workflow error channel (cluster handles retry/dedup).
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

// 3. Business logic — fetch markets → transform → persist.
export class PriceSnapshotWorkflowBusinessLogic extends Effect.Service<PriceSnapshotWorkflowBusinessLogic>()(
  "PriceSnapshotWorkflowBusinessLogic",
  {
    effect: Effect.gen(function*() {
      const client = yield* CoinGeckoClient
      const repo = yield* CoinGeckoRepository

      return {
        run: (runId: string) =>
          pipe(
            client.getMarkets,
            Effect.delay("2 seconds"),
            Effect.retry(fetchSchedule),
            Effect.mapError((error) => new PriceSnapshotWorkflowError({ message: `fetchMarkets failed: ${error}` })),
            Effect.map((markets) =>
              markets.map((m) => ({
                runId,
                coinId: m.id,
                symbol: m.symbol,
                name: m.name,
                currentPrice: m.currentPrice,
                marketCap: m.marketCap,
                priceChangePct: m.priceChangePercentage24h
              }))
            ),
            Effect.flatMap((rows) => repo.insertPriceSnapshots(rows)),
            Effect.asVoid
          )
      }
    }),
    dependencies: [CoinGeckoClient.Default, CoinGeckoRepository.Default]
  }
) {}

// 4. Logic adapter — registered by the runner via Workflow.toLayer(...).
export const PriceSnapshotWorkflowLogic = (
  payload: { readonly runId: string },
  executionId: string
) =>
  Effect.gen(function*() {
    yield* Effect.logDebug(`PriceSnapshotWorkflow execution ${executionId}`)
    const logic = yield* PriceSnapshotWorkflowBusinessLogic
    return yield* logic.run(payload.runId)
  })
