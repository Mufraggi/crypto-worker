---
name: sql-repository
description: "Effect @effect/sql pattern for exposing an entity's DB access: free CRUD via Model.makeRepository plus typed custom queries via SqlSchema, injected as an Effect.Service. Use to build the single layer that touches raw SQL for a given entity (joins, projections, aggregates) while keeping everything above it typed."
---

## When to use

For any sql-model entity that needs:
- a **basic CRUD** (insert / findById / update / delete) — `Model.makeRepository` gives it for free,
- **custom queries** (joins, partial projections, aggregates) — `SqlSchema.findOne` / `findAll` / `void` makes them typed,
- to be **injected as a service** into business effect-services (workflows, handlers).

The repository is the **only layer** that touches raw SQL. Everything above it is typed.

## Procedure

1. Create an `Effect.Service` (see effect-service) that yields `SqlClient.SqlClient` at the top.
2. **CRUD for free**: for each sql-model, call `Model.makeRepository(Model, { tableName, spanPrefix, idColumn })`. Returns `{ insert, update, findById, delete }`.
3. **Custom query**: two-step pattern.
   - Define a `SqlSchema.findOne` (or `findAll`, `single`, `void`) with `Request` (input schema), `Result` (output schema), `execute` (SQL template).
   - Systematic wrapper: `pipe(schema(input), Effect.orDie, Effect.withSpan("Repo.method"))`.
4. **Hide the internal schemas**, expose only the wrappers in the final `return { ... }`. The `*Schema` stays local.
5. `dependencies: [PgLive]` — the DB connection layer.
6. Export a typed Layer alias: `export const XxxRepositoryLayer: Layer.Layer<XxxRepository, ConfigError | SqlError | PlatformError, never> = XxxRepository.Default` — handy for composition on the app side.

## Pitfalls

- **`Effect.orDie` is an architectural choice**. It turns `SqlError`s into defects (`Cause.die`) — so they're absent from the typed `E` channel. Callers **cannot** catch them. That's intentional: a DB failure = global 500, not a business error. If a query can legitimately fail (an expected unique constraint), keep it in `E` and map it to a tagged-errors.
- **`Effect.withSpan` on every public method**. Otherwise observability is blind. Naming convention: `"RepoName.methodName"` — makes OTel filtering easy.
- **Missing or duplicated span name**. In the example, several methods share `"AuthRepository.findByUserId"` — a frequent copy-paste bug that makes tracing useless. **Always check span names are unique**.
- **`SqlSchema.void` for writes with no return**. More correct than a `findOne` you ignore — expresses the intent and avoids a decoding round-trip.
- **snake_case ↔ camelCase**. The `SqlClient` can be configured with `transform: "camel"` to map automatically. Otherwise, **explicit alias** in the SQL (`a.password_hash AS "passwordHash"`). Mixing the two conventions without aliasing = `Schema decode failed` at runtime.
- **Exposing the raw `Model.makeRepository`**. Doing `insertAuth: repoAuth.insert` directly in the `return` is fine for a simple CRUD, but if you want to add log / validation / a custom span, wrap it first.
- **Cross-aggregate joins**. When a query joins several entities (`auth + user + admin + licence`), it's tempting to drop it into `AuthRepository`. Question to ask: is the projection *proper to the Auth aggregate*, or is it a denormalized view? If it's a view, consider a separate `ReadModelRepository`.

## Example

```ts
import { Model, SqlClient, SqlSchema } from "@effect/sql"
import { Effect, pipe, Schema, Layer } from "effect"
import { PgLive } from "@template/database/Sql"
import { Auth } from "../models/AuthModel.js"
import { AuthId, Email, PasswordHash } from "../../domain/AuthType.js"
import { UserId } from "../../domain/account/AccountTypes.js"

export class AuthRepository extends Effect.Service<AuthRepository>()(
  "AuthRepository",
  {
    effect: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      // 1. CRUD for free via the Model
      const repoAuth = yield* Model.makeRepository(Auth, {
        tableName: "auth",
        spanPrefix: "authRepo",
        idColumn: "id"
      })

      // 2. Custom query — local schema
      const findByEmailSchema = SqlSchema.findOne({
        Request: Email,
        Result: Schema.Struct({ id: UserId, passwordHash: PasswordHash }),
        execute: (key) => sql`
          SELECT u.id, a.password_hash AS "passwordHash"
          FROM auth a
          LEFT JOIN "user" u ON u.auth_id = a.id
          WHERE a.email = ${key}
        `
      })
      // 3. Public wrapper: orDie + withSpan
      const findByEmail = (email: Email) =>
        pipe(
          findByEmailSchema(email),
          Effect.orDie,
          Effect.withSpan("AuthRepository.findByEmail")
        )

      // Write with no return → SqlSchema.void
      const updateLastLoginSchema = SqlSchema.void({
        Request: Email,
        execute: (email) =>
          sql`UPDATE auth SET last_login = now() WHERE email = ${email}`
      })
      const updateLastLogin = (email: Email) =>
        pipe(
          updateLastLoginSchema(email),
          Effect.orDie,
          Effect.withSpan("AuthRepository.updateLastLogin")
        )

      // 4. Public API: CRUD + customs, without exposing the *Schema
      return {
        insertAuth: repoAuth.insert,
        updateAuth: repoAuth.update,
        findAuthById: repoAuth.findById,
        deleteAuth: repoAuth.delete,
        findByEmail,
        updateLastLogin
      }
    }),
    dependencies: [PgLive]
  }
) {}

// Typed Layer alias for composition
export const AuthRepositoryLayer: Layer.Layer<
  AuthRepository,
  never,
  never
> = AuthRepository.Default
```

## Related

- sql-model — the entity consumed by the repo
- effect-service — overall structure of the repository as a service
- branded-types — parameter types (`Email`, `UserId`, …)
- tagged-errors — when to keep a `SqlError` in the `E` channel rather than `orDie`
