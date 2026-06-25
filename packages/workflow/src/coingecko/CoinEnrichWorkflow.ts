import { Activity, Workflow } from "@effect/workflow"
import { Effect, pipe, Schedule, Schema } from "effect"
import { CoinGeckoClient } from "./CoinGeckoClient.js"
import { CoinGeckoRepository } from "./CoinGeckoRepository.js"
import { CoinDetail } from "./CoinGeckoSchemas.js"

// 1. Tagged error — propagated on the workflow error channel (cluster handles retry/dedup).
export class CoinEnrichWorkflowError extends Schema.TaggedError<CoinEnrichWorkflowError>()(
  "CoinEnrichWorkflowError",
  { message: Schema.String }
) {}

// 2. Durable handle — fetch metadata for one coin and upsert into demo_coin_details.
//    idempotencyKey derives from the stable coinId (NOT a timestamp) so re-firing dedups.
export const CoinEnrichWorkflow = Workflow.make({
  name: "CoinEnrichWorkflow",
  payload: Schema.Struct({ coinId: Schema.String }),
  idempotencyKey: (payload: { coinId: string }) => payload.coinId,
  success: Schema.Void,
  error: CoinEnrichWorkflowError
})

// Throttle (public rate limit 30 req/min) + bounded exponential retry on transient failures.
const fetchSchedule = Schedule.exponential("2 seconds").pipe(
  Schedule.jittered,
  Schedule.compose(Schedule.recurs(5))
)

// 3. Business logic — granular steps, one per durable Activity. Each stays pure domain + typed
//    errors (client/repo captured in the closure), so its R is `never`.
export class CoinEnrichWorkflowBusinessLogic extends Effect.Service<CoinEnrichWorkflowBusinessLogic>()(
  "CoinEnrichWorkflowBusinessLogic",
  {
    effect: Effect.gen(function*() {
      const client = yield* CoinGeckoClient
      const repo = yield* CoinGeckoRepository

      return {
        fetchCoinDetail: (coinId: string) =>
          pipe(
            client.getCoinDetail(coinId),
            Effect.delay("2 seconds"),
            Effect.retry(fetchSchedule),
            Effect.mapError((error) =>
              new CoinEnrichWorkflowError({ message: `fetchCoinDetail failed for ${coinId}: ${error}` })
            )
          ),
        upsertCoinDetail: (detail: CoinDetail) => repo.upsertCoinDetail(detail)
      }
    }),
    dependencies: [CoinGeckoClient.Default, CoinGeckoRepository.Default]
  }
) {}

// 4. Logic adapter — registered by the runner via Workflow.toLayer(...). Each step is wrapped in
//    Activity.make so its result is journaled: on resume, a completed fetch is NOT re-run (no
//    wasted CoinGecko call) and only the failed step retries.
export const CoinEnrichWorkflowLogic = (
  payload: { readonly coinId: string },
  executionId: string
) =>
  Effect.gen(function*() {
    yield* Effect.logDebug(`CoinEnrichWorkflow execution ${executionId}`)
    const logic = yield* CoinEnrichWorkflowBusinessLogic

    const detail = yield* Activity.make({
      name: "fetchCoinDetail",
      success: CoinDetail,
      error: CoinEnrichWorkflowError,
      execute: logic.fetchCoinDetail(payload.coinId)
    })

    yield* Activity.make({
      name: "upsertCoinDetail",
      execute: logic.upsertCoinDetail(detail)
    })
  })
