import { Effect } from "effect"
import { randomUUID } from "node:crypto"

/** Service de génération d'UUID, injectable via Effect. */
export class Uuid extends Effect.Service<Uuid>()("Uuid", {
  succeed: {
    generate: Effect.sync(() => randomUUID())
  }
}) {}
