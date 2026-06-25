---
name: cqrs-command-query
description: "Effect/TypeScript architecture pattern for lightweight CQRS — one Effect.Service per intent (mutating command or read query) consumed by thin HTTP handlers, with infra errors turned into defects. Use when an HTTP module has more than 2-3 endpoints and the logic between handler and repo is non-trivial (multi-service orchestration, transactions, data enrichment)."
---

## When to use

As soon as an HTTP module has more than 2-3 endpoints **and** the logic between handler and repo is non-trivial (multi-service orchestration, transaction, data enrichment).

This is **lightweight CQRS**: the split is structural (commands vs. queries), not architectural (no event sourcing, no dedicated read model). The goal: **thin handlers, intents explicitly named, reuse made possible** (the same `LoginCommand` can serve HTTP and a CLI).

The layout that works in this codebase:

```
packages/<module>/src/api/
├── commands/          # mutations: Login, ChangePassword, StartEmailChange, …
├── queries/           # reads: FindMe, GetAccountDetails, ValidatePasswordResetLink, …
├── middlewares/       # see http-api-middleware
├── services/          # technical cross-cutting concerns inside the module (rate limiter, …)
└── security.ts
```

## Procedure

1. **One file = one intent**. No `AuthCommand` with 10 methods. `LoginCommand`, `ChangePasswordCommand`, etc., each in its own file.
2. **Implementation = effect-service with a single `run` method** (sometimes `change`, `update` — a business verb). The public API is minimal.
3. **Tag naming**: namespaced. `"@template/api/auth/commands/LoginCommand"`. Avoids collisions across modules and makes grepping easier.
4. **Layer export**: `export const XxxCommandLayer = XxxCommand.Default`. Consumed by http-api-handlers in its `Layer.provide([...])` array.
5. **Distinguish Command from Query**:
   - **Command**: mutation. May wrap in `sql.withTransaction` when there are multiple writes. Can fail with business tagged-errors.
   - **Query**: read. No transaction (except for joins requiring a consistent snapshot). Can enrich with "neutral" side effects (signing a URL, loading a blob).
6. **Infra errors → defects**. `Effect.catchTag("SqlError", Effect.die)` and `Effect.catchTag("ParseError", Effect.die)` at the end of the pipe — the service's `E` channel only carries business errors, no DB noise. Consistent with sql-repository, which already does `Effect.orDie`.
7. **Handler stays thin**: `yield* command.run(payload)` and that's it. No conditional logic, no orchestration.

## Pitfalls

- **Confusion with "real" CQRS**. This pattern **does not** give you: event sourcing, a separate read model, asynchronous sync. If someone talks about "projections" or "rebuild from events", we're not in the same world — a refactor is needed, not just a rename.
- **Command that does too much**. A `RegisterUserAndSendWelcomeEmailAndCreateBillingAccountCommand` = 3 commands in disguise. Split by transactional invariant: what must be atomic stays together, the rest becomes a fire-and-forget workflow (see `{ discard: true }` in http-api-handlers).
- **Query that mutates**. Temptation: "while I'm loading the user, let me update `lastSeenAt`". No — the mutation goes in a separate `TouchLastSeenCommand`, fired in parallel. Otherwise, a replayed query shifts state (cache miss, retry).
- **Repo called directly from the handler**. Compiles and works, but short-circuits the CQRS layer. Acceptable only for trivial routes (`GET /health`). As soon as there are 2 chained operations, create a query.
- **Copy-pasted tag string**. `"@template/api/auth/commands/LoginCommand"` copied into `RegisterCommand` without renaming = silent collision at runtime (one service overwrites the other in the Effect registry). Always check uniqueness.
- **`sql.withTransaction` placed wrong**. Must wrap the **entire** pipe that mutates, not just the `update`. If password verification is needlessly inside the transaction, you hold a row lock too long. Inverse: if the `update` is outside the transaction, you lose atomicity. Correct pattern in `LoginCommand`: everything is in the pipe, `sql.withTransaction` at the end before the `catchTag`s.
- **Catch infra too broadly**. `Effect.catchAll(Effect.die)` also swallows business `TaggedError`s. Always target by tag (`catchTag("SqlError", ...)`), not `catchAll`.
- **Query returning the raw DB model**. Tight coupling between client ↔ schema. For complex views, return a dedicated schema (`MeInfo`, `ClientAccountDetails`, `UserMeInvyo`) — not the sql-model entity.
- **On the command side: minimal return**. A command typically returns the created id / `{ success: true }` / the tokens — not the full DTO. If the client needs the enriched object, it makes a separate query call (the codebase's `updateAccount` pattern calls `getClientAccountDetailsQuery.run` after the mutation — clean).

## Example

### Command (mutation with transaction)

```ts
import { SqlClient } from "@effect/sql"
import { Sql } from "@template/database"
import { Effect, Option, pipe } from "effect"
import { AuthRepository, AuthRepositoryLayer } from "../../database/repository/AuthRepository.js"
import { InvalidCredentialsError } from "../../domain/bcryptError/BcryptError.js"
import type { LoginInput } from "../../domain/input/LoginInput.js"
import { UserEmailNotFound } from "@template/domain/user/UserError"
import { BcryptService } from "../../services/BcryptService.js"
import { JwtService } from "../../services/JwtService.js"

export class LoginCommand extends Effect.Service<LoginCommand>()(
  "@template/api/auth/commands/LoginCommand",
  {
    effect: Effect.gen(function* () {
      const repo = yield* AuthRepository
      const bcrypt = yield* BcryptService
      const jwt = yield* JwtService
      const sql = yield* SqlClient.SqlClient

      const run = (payload: LoginInput) =>
        pipe(
          repo.findByEmail(payload.email),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new UserEmailNotFound({ email: payload.email })),
            onSome: Effect.succeed
          })),
          Effect.flatMap((user) =>
            bcrypt.verifyPassword(payload.password, user.passwordHash).pipe(
              Effect.flatMap((ok) =>
                ok
                  ? Effect.succeed(user)
                  : Effect.fail(new InvalidCredentialsError({ message: "Invalid password" }))
              )
            )
          ),
          Effect.flatMap((user) =>
            repo.updateLastLogin(payload.email).pipe(
              Effect.andThen(Effect.all([
                jwt.signAccessToken({ userId: user.id }),
                jwt.signRefreshToken({ userId: user.id })
              ]))
            )
          ),
          Effect.map(([accessToken, refreshToken]) => ({ accessToken, refreshToken })),
          // Transaction over the whole business pipe
          sql.withTransaction,
          // Infra errors → defects (not in E)
          Effect.catchTag("SqlError", Effect.die),
          Effect.catchTag("ParseError", Effect.die)
        )

      return { run }
    }),
    dependencies: [
      AuthRepositoryLayer,
      BcryptService.Default,
      Sql.PgLive,
      JwtService.Default
    ]
  }
) {}

export const LoginCommandLayer = LoginCommand.Default
```

### Query (read + enrichment)

```ts
import { BlobStorageClient } from "@template/backend-utils/BlobStorageClient"
import { BlobContainerName, BlobPathBase, FileName, TimeOutUrlBlob } from "@template/domain/BlobStorage/BlobStorageType"
import { UserIdNotFound } from "@template/domain/user/UserError"
import type { UserId } from "@template/domain/user/UserType"
import { Config, Effect, Option, pipe } from "effect"
import { AuthRepository, AuthRepositoryLayer } from "../../database/repository/AuthRepository.js"

export class UserMeQuery extends Effect.Service<UserMeQuery>()(
  "@template/api/auth/queries/UserMeQuery",
  {
    effect: Effect.gen(function* () {
      const repo = yield* AuthRepository
      const blob = yield* BlobStorageClient
      const container = yield* Config.string("BLOB_CONTAINER_NAME")
      const THEME_BASE = BlobPathBase.make("LICENCES_THEME")

      const run = (id: UserId) =>
        pipe(
          repo.findLicenceUserMeByUserId(id),
          Effect.flatMap(Option.match({
            onNone: () => Effect.fail(new UserIdNotFound({ id })),
            onSome: Effect.succeed
          })),
          // Enrichment: sign the URL if present
          Effect.flatMap((licence) =>
            (licence.logoUrl
              ? blob.signedUrl(
                  BlobContainerName.make(container),
                  THEME_BASE,
                  FileName.make(licence.logoUrl),
                  TimeOutUrlBlob.make(60)
                )
              : Effect.succeed<string | null>(null)
            ).pipe(
              Effect.map((signedUrl) => ({ ...licence, logoUrl: signedUrl }))
            )
          )
        )

      return { run }
    }),
    dependencies: [AuthRepositoryLayer, BlobStorageClient.Default]
  }
) {}

export const UserMeQueryLayer = UserMeQuery.Default
```

## Related

- effect-service — each Command/Query is a service
- sql-repository — the DB layer being consumed
- tagged-errors — business errors in `E`
- http-api-handlers — consumes the yielded Command/Query
- branded-types — payload/return typed via brands
