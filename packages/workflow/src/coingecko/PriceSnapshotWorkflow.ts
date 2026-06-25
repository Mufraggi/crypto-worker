import { Workflow } from "@effect/workflow"
import { Schema } from "effect"

/**
 * Workflow that captures a snapshot of top coin prices from CoinGecko
 * and persists them to the demo_price_snapshots table.
 */
export const PriceSnapshotWorkflow = Workflow.make({
  name: "PriceSnapshotWorkflow",
  payload: Schema.Struct({
    runId: Schema.String
  }),
  idempotencyKey: (payload: { runId: string }) => payload.runId,
  success: Schema.Void,
  error: Schema.Never
})
