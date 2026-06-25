import type { Layer } from "effect"

/**
 * Convention de ce package — un workflow vit dans `src/<name>/` :
 *  - `<Name>Workflow.ts` : `Workflow.make({ name, success, error, payload, idempotencyKey })`
 *  - `<Name>Worker.ts`   : `(payload, executionId) => Effect.gen(...)` qui appelle le service
 *  - `Service<Name>.ts`  : `Effect.Service` (business logic), dépend des repositories de `@template/database`
 *
 * Le worker enregistre `<Name>Workflow.toLayer(<Name>Worker)` et l'agrège dans son `MainLayer`.
 */
export type WorkflowLayer = Layer.Layer<never>
