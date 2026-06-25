import { Workflow } from "@effect/workflow"
import { Schema } from "effect"

/**
 * Workflow that fetches detailed metadata for a single coin from CoinGecko
 * and persists it to the demo_coin_details table.
 */
export const CoinEnrichWorkflow = Workflow.make({
  name: "CoinEnrichWorkflow",
  payload: Schema.Struct({
    coinId: Schema.String
  }),
  idempotencyKey: (payload: { coinId: string }) => `enrich-${payload.coinId}-${Date.now()}`,
  success: Schema.Void,
  error: Schema.Never
})
