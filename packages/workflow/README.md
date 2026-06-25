# Crypto Worker - Workflow Package

Workflows asynchrones (`@effect/workflow`), exécutés par l'app `worker`.

## Convention par workflow (`src/<name>/`)

- `<Name>Workflow.ts` — `Workflow.make({ name, success, error, payload, idempotencyKey })`.
- `<Name>Worker.ts` — `(payload, executionId) => Effect.gen(...)` qui appelle le service.
- `Service<Name>.ts` — `Effect.Service` (business logic), dépend des repositories de `@template/database`.

Le worker enregistre ensuite `<Name>Workflow.toLayer(<Name>Worker)` dans son `MainLayer`.
