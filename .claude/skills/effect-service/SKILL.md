---
name: effect-service
description: "Effect/TypeScript pattern for encapsulating business logic with injectable dependencies using Effect.Service. Use when a piece of logic has several dependencies to inject, is reused by multiple callers (HTTP handler, worker, another service), or must be mockable in tests — replaces the Context.Tag + Layer.effect boilerplate."
---

## When to use

As soon as a piece of logic:
- has **several dependencies** (repo, HTTP client, mailer…) you want to inject,
- is **reused** by multiple callers (HTTP handler, worker, another service),
- needs to be **mockable** in tests without touching the business code.

`Effect.Service` replaces the `Context.Tag` + `Layer.effect` boilerplate: a single class declares the tag, the implementation, **and** its default layer.

## Procedure

1. Create a class `class XxxService extends Effect.Service<XxxService>()("XxxService", { ... }) {}`.
   - Class name **and** identity string **identical** (not checked by the compiler — a classic source of bugs).
   - The trailing `{}` is mandatory (empty class body).
2. Pick the instance factory:
   - `effect: Effect.gen(...)` — standard case, can yield other services.
   - `sync: () => ({...})` — pure, no dependencies and no effects.
   - `scoped: Effect.gen(...)` — resource with cleanup (connection pool, etc.).
3. Inside the `Effect.gen`, **yield all dependencies at the top**. They become shared closures.
4. Define **local helpers** (here `errorWorkflow`) between the `yield*`s and the `return`. They capture the deps via closure — no need to re-yield them.
5. `return { method1, method2, ... }` — the returned object is the **public interface** of the service. Anything not in it is private.
6. List the dependencies in `dependencies: [Dep1.Default, Dep2.Layer, ...]`. Effect bundles these layers into `XxxService.Default` → the caller only has to provide a single layer.
7. On the caller side: `yield* XxxService` to grab it; `Layer.provide(XxxService.Default)` to wire it up.

## Pitfalls

- **Work in the constructor vs. in the methods**. Everything before `return { ... }` runs **once** when the layer is built (singleton). Per-call work must go **inside** the returned methods. Classic mistake: doing a `repo.getById` at the top level.
- **The tag string and the class name must match**. Otherwise the service is registered under one identifier and looked up under another → `Service not found` at runtime, no compile error.
- **API surface**. Whatever you put in the `return` becomes the contract. Keep the object minimal — no internal helpers exposed.
- **`dependencies` ≠ `Layer.provide`**. `dependencies` makes the service **self-contained** (its `.Default` embeds everything). If you want to swap a dep in tests, do NOT put it in `dependencies` — provide it separately at `Layer.provide` time.
- **No cycles**. If A depends on B and B depends on A, the `dependencies` array creates a cycle that isn't caught at compile time. Break it via a third abstraction.
- **Typed errors**. The `E` channel of the returned methods **must** be a tagged-errors or a union. Avoid `Effect.fail("string")`, which pollutes the channel.
- **Logs before tap()**. `Effect.log("before: ", x)` doesn't work inside a `pipe` — use `Effect.tap((x) => Effect.log("before:", x))`. The example below does it right.

## Example

```ts
import { Boolean, Effect, Option, pipe } from "effect"
import { constant } from "effect/Function"

export class CreateAdminEmailSendWorkflowBusinessLogic
  extends Effect.Service<CreateAdminEmailSendWorkflowBusinessLogic>()(
    "CreateAdminEmailSendWorkflowBusinessLogic",
    {
      effect: Effect.gen(function* () {
        // 1. Dependencies yielded at the top
        const mailer = yield* MaillerClient
        const repo = yield* AccountCreationEmailRepository
        const adminRepo = yield* AdminRepository

        // 2. Local helpers that close over the deps
        const errorWorkflow = (
          accountEmail: AccountCreationEmailModel,
          status: StatusSchemaEmail,
          messageError: string
        ) =>
          repo.update({ ...accountEmail, status }).pipe(
            Effect.andThen(
              Effect.fail(new CreateAdminEmailSendWorkflowError({ message: messageError }))
            )
          )

        // 3. Public API of the service
        return {
          run: (id: AccountCreationEmailId) =>
            pipe(
              repo.getById(id),
              Effect.flatMap(Option.match({
                onNone: () =>
                  Effect.fail(
                    new CreateAdminEmailSendWorkflowError({
                      message: `AccountCreationEmail not found ${id}`
                    })
                  ),
                onSome: Effect.succeed
              })),
              Effect.flatMap((accountCreationEmail) =>
                adminRepo.getAdminFullByUserId(accountCreationEmail.userId).pipe(
                  Effect.flatMap(Option.match({
                    onNone: () =>
                      errorWorkflow(
                        accountCreationEmail,
                        "expired",
                        `Email as expired ${accountCreationEmail.id}`
                      ),
                    onSome: (admin) =>
                      Effect.succeed({ admin, accountCreationEmail } as const)
                  }))
                )
              ),
              Effect.flatMap(({ accountCreationEmail, admin }) => {
                const isExpired = false
                return Boolean.match(!isExpired, {
                  onFalse: constant(
                    errorWorkflow(
                      accountCreationEmail,
                      "expired",
                      `Email as expired ${accountCreationEmail.id}`
                    )
                  ),
                  onTrue: constant(
                    pipe(
                      mailer.sendMail({
                        from: "notifications@sprint-analytics.com",
                        to: accountCreationEmail.emailAddress,
                        subject: "[Sprint project] Welcome on new admin",
                        template: "adminCreation",
                        context: {
                          firstName: admin.firstname,
                          activationUrl: `${accountCreationEmail.activationUrl}${accountCreationEmail.id}`
                        }
                      }),
                      Effect.mapError((error) =>
                        new CreateAdminEmailSendWorkflowError({
                          message: `Failed to send email: ${error.message}`
                        })
                      ),
                      Effect.andThen(
                        repo.update({
                          ...accountCreationEmail,
                          sentAt: new Date(),
                          status: "sent"
                        })
                      )
                    )
                  )
                })
              })
            )
        }
      }),
      // 4. Self-contained layer: .Default bundles everything
      dependencies: [
        MaillerClient.Resend,
        AccountCreationEmailRepositoryLayer,
        AdminRepository.Default
      ]
    }
  ) {}

// Caller-side usage
const program = Effect.gen(function* () {
  const workflow = yield* CreateAdminEmailSendWorkflowBusinessLogic
  yield* workflow.run(someId)
})

const runnable = program.pipe(
  Effect.provide(CreateAdminEmailSendWorkflowBusinessLogic.Default)
)
```

## Related

- tagged-errors — business errors in services should be `TaggedError`s
- branded-types — method parameters (e.g. `AccountCreationEmailId`) are branded types
