---
name: cluster-workflow-definition
description: "Effect @effect/cluster + @effect/workflow pattern for defining a durable, idempotent background job (email, sync, projection) with Workflow.make — the handle, the business-logic Effect.Service, and the Logic adapter in one file. Use when a unit of work must run outside the request lifecycle, survive crashes/retries, and execute exactly once per logical key."
---

## When to use

As soon as a unit of work must run **outside the request lifecycle** and survive crashes/retries:
- side-effecting jobs (send email, resize image, call an LLM),
- syncs and projections that take time or hit flaky third parties,
- anything you want **executed exactly once per logical key**, even if triggered twice.

`Workflow.make` (from `@effect/cluster`) gives you a durable handle: a typed payload, a typed `success`/`error` channel, and — crucially — an **idempotency key**. The cluster engine deduplicates by that key, so re-firing the same workflow is safe.

A workflow definition is made of **three pieces that live in the same file** and are exported together:
1. the `Workflow.make` handle,
2. the `Effect.Service` business logic (see effect-service),
3. a thin `Logic` adapter function that the runner registers.

## Procedure

1. **Tagged error** — declare the failure type with `Schema.TaggedError` (see tagged-errors). One error class per workflow; class name === tag string.

2. **The handle** — `Workflow.make({ ... })`:
   - `name` — unique string across the whole cluster. Collisions silently route work to the wrong handler.
   - `success` — output schema. `Schema.Void` for fire-and-forget jobs.
   - `error` — the tagged error from step 1.
   - `payload` — an **object** of schemas (use branded-types for ids), not a positional list.
   - `idempotencyKey: (payload) => string` — the dedup key. Derive it from a **stable, meaningful** field (the entity id), never from a timestamp or random value, or you lose the exactly-once guarantee.

3. **Business logic** — an effect-service (`XxxWorkflowBusinessLogic`) that yields its deps at the top and exposes a single `run(...)` method. Keep all transport/wiring out of here; it's pure domain logic + typed errors.

4. **Logic adapter** — a function `(payload, executionId) => Effect.gen(...)` that:
   - logs the `executionId` (handy for tracing retries — same id = same attempt chain),
   - `yield*`s the business-logic service,
   - returns `BusinessLogic.run(payload.<field>)`.
   This indirection is what the runner passes to `Workflow.toLayer` (see cluster-workflow-runner). The workflow handle, the engine, and the implementation stay decoupled.

5. **Export the trio**: `{ XxxWorkflow, XxxWorkflowError, XxxWorkflowLogic }` and the `XxxWorkflowBusinessLogic` class. The runner needs all of them.

## Pitfalls

- **Idempotency key from the wrong source.** A key built from `new Date()` or anything non-deterministic defeats the engine: every trigger looks new, the job runs twice. Key on the domain id (`({ id }) => id`).
- **Effects/`Date.now()` in the constructor.** Everything before `return { run }` in the service runs **once** at layer build (singleton). Per-call work — fetching the row, sending the mail, stamping `sentAt: new Date()` — must live **inside** `run`. Same trap as effect-service.
- **Untyped error channel.** `success`/`error` of the handle must line up with what `run` actually produces. If `run` can fail with anything other than the declared `Workflow.error`, the layer won't type-check at registration. Map foreign errors (`Effect.mapError`) into your tagged error.
- **The handle ≠ the implementation.** `Workflow.make` only declares the contract. Nothing runs until the runner wires `toLayer(Logic)` + the business-logic `.Default` + the engine (see cluster-workflow-runner). A defined-but-unregistered workflow silently never executes.
- **`name` must be globally unique.** It's the routing key inside the cluster, independent of the JS symbol. Copy-pasting a workflow and forgetting to rename `name` makes two workflows fight over the same queue.
- **Don't swallow `Option`.** `repo.getById` returns an `Option`; `onNone` must `Effect.fail` your tagged error, not silently succeed — otherwise a missing row looks like success and the job is marked done.

## Example

```ts
import { Workflow } from "@effect/workflow"
import { Effect, Option, pipe, Schema } from "effect"
import { AccountCreationEmailId } from "@template/domain/invation/InvitationType"

// 1. Tagged error — see tagged-errors
class CreateAdminEmailSendWorkflowError extends Schema.TaggedError<CreateAdminEmailSendWorkflowError>(
  "CreateAdminEmailSendWorkflowError"
)("CreateAdminEmailSendWorkflowError", {
  message: Schema.String
}) {}

// 2. The durable handle — contract only
const CreateAdminEmailSendWorkflow = Workflow.make({
  name: "CreateAdminEmailSendWorkflow",        // unique across the cluster
  success: Schema.Void,                        // fire-and-forget
  error: CreateAdminEmailSendWorkflowError,
  payload: {
    id: AccountCreationEmailId                 // branded id — see branded-types
  },
  idempotencyKey: ({ id }) => id               // dedup on the domain id, NOT a timestamp
})

// 3. Business logic — an Effect.Service, see effect-service
export class CreateAdminEmailSendWorkflowBussinessLogic extends Effect.Service<
  CreateAdminEmailSendWorkflowBussinessLogic
>()("CreateAdminEmailSendWorkflowBussinessLogic", {
  effect: Effect.gen(function* () {
    const mailer = yield* MaillerClient
    const repo = yield* AccountCreationEmailRepository
    const adminRepo = yield* AdminRepository

    const errorWorkFlow = (account: AccountCreationEmailModel, status: StatusSchemaEmail, msg: string) =>
      repo.update({ ...account, status }).pipe(
        Effect.andThen(Effect.fail(new CreateAdminEmailSendWorkflowError({ message: msg })))
      )

    return {
      // per-call work lives HERE, not in the constructor
      run: (id: AccountCreationEmailId) =>
        pipe(
          repo.getById(id),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(
              new CreateAdminEmailSendWorkflowError({ message: `AccountCreationEmail not found ${id}` })
            ),
            onSome: Effect.succeed
          })),
          // ... resolve admin, check expiry, send mail, stamp sentAt: new Date() ...
        )
    }
  }),
  dependencies: [MaillerClient.Resend, AccountCreationEmailRepositoryLayer, AdminRepository.Default]
}) {}

// 4. Logic adapter — what the runner registers via toLayer(...)
const CreateAdminEmailSendWorkflowLogic = (
  payload: { id: AccountCreationEmailId },
  executionId: string
) =>
  Effect.gen(function* () {
    yield* Effect.logDebug(`${executionId}`)            // same id across a retry chain
    const businessLogic = yield* CreateAdminEmailSendWorkflowBussinessLogic
    return yield* businessLogic.run(payload.id)
  })

// 5. Export the trio (+ the business-logic class)
export {
  CreateAdminEmailSendWorkflow,
  CreateAdminEmailSendWorkflowError,
  CreateAdminEmailSendWorkflowLogic
}
```

## Related

- cluster-workflow-runner — wire the workflow into the runner's `MainLayer` with `toLayer` + provide stack
- effect-service — the business-logic class is a standard `Effect.Service`
- tagged-errors — the `error` channel of the workflow must be a `Schema.TaggedError`
- branded-types — payload ids (`AccountCreationEmailId`) are branded
