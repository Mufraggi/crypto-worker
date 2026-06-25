---
name: policy-system
description: "Effect/TypeScript pattern for authorization gates: typed role/permission policies with a phantom-proof AuthorizedActor, a permissions matrix locked by `satisfies`, and policyUse piped onto handlers. Use to gate an operation behind RBAC or predicate-based authorization (403) without leaking permission logic into the business layer."
---

## When to use

When an entity action must be **authorized** before it runs:
- a **role-based gate** (RBAC) — "only SuperAdmin/Manager can delete a Company",
- a **predicate-based gate** — "only an active-premium licence can list PDFs",
- to attach that gate to an HTTP handler **without leaking it into the business layer** (cqrs-command-query, workflows stay policy-agnostic),
- to obtain a **compile-time proof** that authorization happened (phantom `AuthorizedActor`), so a handler that forgets the check fails to type-check or carries a dangling requirement.

The policy layer reads the actor from context (provided by http-api-middleware) and is the **only** place permission logic lives. Business services never see roles.

## Procedure

1. **Actor + context tag.** Define the JWT actor as a `Schema.Class` (`UserJwtToken` with `id`, `roleId`, `roleName`, `companyId`) and a `Context.Tag` (`CurrentUserAdmin`) that the middleware provides. See http-api-middleware.
2. **`Forbidden` (403).** A `Schema.TaggedError` carrying `actorId`, `roleName`, `entity`, `action` with `HttpApiSchema.annotations({ status: 403 })`. Distinct from the middleware's `Unauthorized` (401). See tagged-errors.
3. **Phantom `AuthorizedActor<Entity, Action>`.** An interface extending `UserJwtToken` tagged with a `unique symbol` `TypeId` carrying phantom `_Entity`/`_Action`. Built via an internal `authorizedActor` cast — never constructed by hand.
4. **`policy(entity, action, f)`** — the only builder. Reads `CurrentUserAdmin`, runs `f(actor): Effect<boolean>`, returns the phantom proof or fails `Forbidden`. `f` returns an **Effect**, not a bare boolean, so a future DB-backed check needs no signature change.
5. **Permissions matrix.** In a separate file (`AdminPolicies.ts`), declare role constants, an `allowRoles(...allowed)` predicate helper, then a nested object `{ entity: { action: policy(...) } }` closed with `satisfies Policies<{ ... }>` to lock entity/action names at the type level.
6. **`policyUse(policyEffect)`** — pipe it onto a business effect in the http-api-handlers. Runs the check first, drops the `AuthorizedActor` requirement from the downstream context, short-circuits on `Forbidden`.
7. **`policyCompose` / `withSystemActor`** for the edges: combine two policies, or strip all `AuthorizedActor` requirements for crons/workers that run without a user.
8. **Mirror for the second audience.** End-users get a parallel stack (`UserPolicy.ts`, `UserPolicies.ts`, `CurrentUserLicence`, `ForbiddenUser`, `userPolicyUse`) with predicates like `allowPremium`/`allowAny` instead of `allowRoles`.

## Pitfalls

- **`policyUse` removes the requirement; forgetting it doesn't fail loudly at runtime.** If you skip `policyUse`, the handler simply runs unguarded — the type system only complains if the effect *still references* an `AuthorizedActor`. The proof is opt-in: treat "every mutating handler pipes a `policyUse`" as a reviewable invariant, not something the compiler guarantees end-to-end.
- **`satisfies Policies<{...}>` is the real guardrail.** Without it, a typo in an entity/action string or a missing action goes unnoticed. The phantom `<Entity, Action>` strings must match the `PolicyGroup` union exactly — keep the matrix and the `satisfies` block in sync.
- **`Forbidden` (403) vs `Unauthorized` (401) are different layers.** Authentication (token missing/invalid → 401) lives in the http-api-middleware; authorization (authenticated but disallowed → 403) lives in the policy. Don't fold one into the other.
- **`allowRoles` compares branded `AdministratorRoleName` by value.** Role names are human strings (`"Super administrator"`) made via `.make()`. A casing/spacing drift between the matrix constants and the DB-seeded role name silently denies everyone. Keep role constants as the single source. See branded-types.
- **`withSystemActor` is a type-level bypass, not an auth check.** It erases `AuthorizedActor` requirements so system jobs compile. Never reach for it inside an HTTP handler to "make the types work" — that disables the gate.
- **Predicate `f` runs in `E`/`R`.** A DB-backed predicate adds its own error/requirement channel to the policy. Keep cheap synchronous checks as `Effect.succeed(...)`; only widen `E`/`R` when the permission genuinely needs IO.
- **Don't push roles into the business service.** The temptation is to `if (actor.roleName === ...)` inside a command. That scatters authorization and defeats the matrix audit. The service stays ignorant; the gate sits at the handler boundary.
- **Frontend mirror must not drift.** A synchronous `canView(role, entity, action)` for UI rendering is a *convenience copy* of the backend matrix, never the enforcement point. The backend `policy` is authoritative; the frontend copy only hides buttons.

## Example

```ts
// ── Policy.ts — core primitives ───────────────────────────────────────────────
import { HttpApiSchema } from "@effect/platform"
import { Context, Effect, Schema } from "effect"
import { AdministratorRoleName } from "../administratorRole/AdministratorRoleType.js"
import { UserId } from "../user/UserType.js"

export class UserJwtToken extends Schema.Class<UserJwtToken>("UserJwtToken")({
  id: UserId,
  roleId: AdministratorId,
  roleName: AdministratorRoleName,
  companyId: AdministratorCompanyId
}) {}

export class CurrentUserAdmin extends Context.Tag("CurrentUserAdmin")<CurrentUserAdmin, UserJwtToken>() {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  "Forbidden",
  { actorId: UserId, roleName: AdministratorRoleName, entity: Schema.String, action: Schema.String },
  HttpApiSchema.annotations({ status: 403 })
) {}

const TypeId: unique symbol = Symbol.for("@template/policy/AuthorizedActor")
export interface AuthorizedActor<Entity extends string, Action extends string> extends UserJwtToken {
  readonly [TypeId]: { readonly _Entity: Entity; readonly _Action: Action }
}
const authorizedActor = <E extends string, A extends string>(a: UserJwtToken) =>
  a as unknown as AuthorizedActor<E, A>

// The only builder: reads actor, evaluates predicate, proves or forbids.
export const policy = <Entity extends string, Action extends string, E, R>(
  entity: Entity,
  action: Action,
  f: (actor: UserJwtToken) => Effect.Effect<boolean, E, R>
): Effect.Effect<AuthorizedActor<Entity, Action>, E | Forbidden, R | CurrentUserAdmin> =>
  Effect.flatMap(CurrentUserAdmin, (actor) =>
    Effect.flatMap(f(actor), (can) =>
      can
        ? Effect.succeed(authorizedActor<Entity, Action>(actor))
        : Effect.fail(new Forbidden({ actorId: actor.id, roleName: actor.roleName, entity, action }))))

// Gate an effect; drops the AuthorizedActor requirement downstream.
export const policyUse = <Actor extends AuthorizedActor<any, any>, E, R>(
  policyEffect: Effect.Effect<Actor, E, R>
) =>
<A, E2, R2>(effect: Effect.Effect<A, E2, R2>): Effect.Effect<A, E | E2, Exclude<R2, Actor> | R> =>
  policyEffect.pipe(Effect.zipRight(effect)) as any

// System bypass for crons/workers (type-level only).
export const withSystemActor = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect as Effect.Effect<A, E, Exclude<R, AuthorizedActor<any, any>>>
```

```ts
// ── AdminPolicies.ts — the permissions matrix ─────────────────────────────────
import { Effect } from "effect"
import { AdministratorRoleName } from "../administratorRole/AdministratorRoleType.js"
import { type Policies, policy, type PolicyGroup } from "./Policy.js"

const SuperAdmin = AdministratorRoleName.make("Super administrator")
const Maintainer = AdministratorRoleName.make("Maintainer")
const Manager = AdministratorRoleName.make("Manager")

// Predicate helper — value-compares the actor's branded role name.
const allowRoles = (...allowed: ReadonlyArray<AdministratorRoleName>) =>
  (actor: { roleName: AdministratorRoleName }) => Effect.succeed(allowed.includes(actor.roleName))

export const AdminPolicies = {
  company: {
    list:   policy("Company", "list",   allowRoles(SuperAdmin, Maintainer, Manager)),
    create: policy("Company", "create", allowRoles(SuperAdmin, Maintainer, Manager)),
    delete: policy("Company", "delete", allowRoles(SuperAdmin, Manager))
  }
} satisfies Policies<{
  // Locks entity + action names — a typo here is a compile error.
  company: PolicyGroup<"Company", "list" | "create" | "delete">
}>
```

```ts
// ── HttpGroup.ts — attach the gate in the handler ─────────────────────────────
import { AdminPolicies } from "@template/domain/policy/AdminPolicies"
import { policyUse } from "@template/domain/policy/Policy"

handlers
  .handle("createCompany", ({ payload }) =>
    createCommand.create(payload).pipe(policyUse(AdminPolicies.company.create)))
  .handle("deleteCompany", ({ path }) =>
    deleteCommand.delete(path.id).pipe(policyUse(AdminPolicies.company.delete)))
// The business commands (createCommand/deleteCommand) know nothing about roles.
// AdminMiddlewareLive (Layer.provide) supplies CurrentUserAdmin to the group.
```

## Related

- http-api-middleware — extracts the JWT, provides `CurrentUserAdmin` / `CurrentUserLicence`, fails `Unauthorized` (401)
- http-api-handlers — where `policyUse` is piped onto the business effect
- cqrs-command-query — the policy-agnostic services the gate wraps
- tagged-errors — `Forbidden` / `ForbiddenUser` as 403 `Schema.TaggedError`s
- branded-types — `AdministratorRoleName`, `UserId`, the actor's typed fields
- effect-service — overall structure of the layers being composed
