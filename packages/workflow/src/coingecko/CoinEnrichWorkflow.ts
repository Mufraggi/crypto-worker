import { Workflow } from "@effect/workflow"
import { Effect, pipe, Schedule, Schema } from "effect"
import { CoinGeckoClient } from "./CoinGeckoClient.js"
import { CoinGeckoRepository } from "./CoinGeckoRepository.js"

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

// 3. Business logic — fetch coin detail → upsert.
export class CoinEnrichWorkflowBusinessLogic extends Effect.Service<CoinEnrichWorkflowBusinessLogic>()(
  "CoinEnrichWorkflowBusinessLogic",
  {
    effect: Effect.gen(function*() {
      const client = yield* CoinGeckoClient
      const repo = yield* CoinGeckoRepository

      return {
        run: (coinId: string) =>
          pipe(
            client.getCoinDetail(coinId),
            Effect.delay("2 seconds"),
            Effect.retry(fetchSchedule),
            Effect.mapError((error) =>
              new CoinEnrichWorkflowError({ message: `fetchCoinDetail failed for ${coinId}: ${error}` })
            ),
            Effect.flatMap((detail) => repo.upsertCoinDetail(detail)),
            Effect.asVoid
          )
      }
    }),
    dependencies: [CoinGeckoClient.Default, CoinGeckoRepository.Default]
  }
) {}

// 4. Logic adapter — registered by the runner via Workflow.toLayer(...).
export const CoinEnrichWorkflowLogic = (
  payload: { readonly coinId: string },
  executionId: string
) =>
  Effect.gen(function*() {
    yield* Effect.logDebug(`CoinEnrichWorkflow execution ${executionId}`)
    const logic = yield* CoinEnrichWorkflowBusinessLogic
    return yield* logic.run(payload.coinId)
  })
