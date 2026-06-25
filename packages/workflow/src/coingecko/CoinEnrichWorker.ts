import { SqlClient } from "@effect/sql"
import { Effect, Schedule } from "effect"
import { CoinGeckoClient } from "./CoinGeckoClient.js"

/**
 * Worker for CoinEnrichWorkflow.
 *
 * Two sequential steps:
 *  1. Fetch coin detail from CoinGecko
 *  2. Upsert into demo_coin_details
 *
 * All errors are caught and logged to satisfy the Never error schema.
 */
export const CoinEnrichWorker = (
  payload: { readonly coinId: string },
  _executionId: string
) =>
  Effect.gen(function*() {
    const client = yield* CoinGeckoClient

    // Step 1 — fetch coin detail
    const detail = yield* client.getCoinDetail(payload.coinId).pipe(
      Effect.delay("2 seconds"),
      Effect.retry(
        Schedule.exponential("2 seconds").pipe(
          Schedule.jittered,
          Schedule.compose(Schedule.recurs(5))
        )
      ),
      Effect.catchAll((error) =>
        Effect.logError(`CoinEnrich fetchCoinDetail failed for ${payload.coinId}: ${error}`).pipe(
          Effect.as(null as any)
        )
      )
    )

    if (detail === null) {
      return
    }

    // Step 2 — upsert into DB
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO demo_coin_details
        (coin_id, symbol, name, description, homepage_url, categories, market_cap_rank, enriched_at)
      VALUES
        (${detail.id}, ${detail.symbol}, ${detail.name},
         ${detail.description}, ${detail.homepageUrl},
         ${detail.categories}, ${detail.marketCapRank},
         ${new Date().toISOString()})
      ON CONFLICT (coin_id)
      DO UPDATE SET
        symbol        = EXCLUDED.symbol,
        name          = EXCLUDED.name,
        description   = EXCLUDED.description,
        homepage_url  = EXCLUDED.homepage_url,
        categories    = EXCLUDED.categories,
        market_cap_rank = EXCLUDED.market_cap_rank,
        enriched_at   = EXCLUDED.enriched_at
    `.pipe(
      Effect.retry({ times: 3 }),
      Effect.catchAll((error) => Effect.logError(`CoinEnrich insertCoinDetail failed for ${payload.coinId}: ${error}`)),
      Effect.asVoid
    )
  })
