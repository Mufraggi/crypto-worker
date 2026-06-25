import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/**
 * Creates the CoinGecko demo tables at application startup.
 *
 * Called once when the worker process starts, before any workflow layers
 * are launched.
 */
export const CoinGeckoMigrations = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS demo_price_snapshots (
      id SERIAL PRIMARY KEY,
      run_id TEXT NOT NULL,
      coin_id TEXT NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      current_price NUMERIC,
      market_cap NUMERIC,
      price_change_pct NUMERIC,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS demo_coin_details (
      id SERIAL PRIMARY KEY,
      coin_id TEXT UNIQUE NOT NULL,
      symbol TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      homepage_url TEXT,
      categories TEXT[],
      market_cap_rank INTEGER,
      enriched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  yield* Effect.log("✅ CoinGecko demo tables ensured")
})
