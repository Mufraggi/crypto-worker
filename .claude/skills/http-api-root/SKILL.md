---
name: http-api-root
description: "Effect @effect/platform pattern for aggregating all endpoint groups into a single root HttpApi (with small infra groups like health/version inline) and exporting its type. Use once per application to tie the global contract to the distributed handler implementations."
---

## When to use

Once per application. It's the **aggregation point** of the http-api-contracts: every group is added via `.add(Group)`. The generated type (`typeof Api`) is then passed to each http-api-handlers factory as a parameter — that's what ties the global contract to the distributed implementations.

Also add the **"infra" groups** typically declared inline here: `health`, `version`, etc. — no need to split them out into a separate file as long as they stay trivial.

## Procedure

1. **Small infra groups inline**: `class HealthGroup extends HttpApiGroup.make("health").add(...).prefix("/health") {}`.
2. **Root**: `class Api extends HttpApi.make("api").add(Group1).add(Group2)... .annotate(OpenApi.Title, "...") {}`.
   - The order of the `.add(...)`s has no runtime impact; sorting by domain helps readability.
   - `OpenApi.Title`, `OpenApi.Version`, `OpenApi.Description` enrich Swagger.
3. **Type alias**: `export type ApiType = typeof Api`. Reused by every `(api: ApiType) => HttpApiBuilder.group(api, "@Group/Xxx", ...)` factory.
4. Double-check: **every imported group must be `.add`ed**. An imported group that was forgotten = invisible routes on both server AND client.

## Pitfalls

- **A forgotten `.add` is silent**. No compile error; the server boots, but the endpoint replies 404. Convention: group the `.add`s by domain + section comment when the list exceeds 20 lines.
- **Duplicate group** (`.add(GroupX).add(GroupX)`). Compiles fine, runtime behavior unspecified. Grep `\.add\(GroupName\)` at the slightest doubt.
- **Group tag string**. The name in `HttpApiGroup.make("@Group/Xxx")` must be **unique** across the whole `Api`. A clash = one group overwrites the other. The `@Group/<Domain>` convention prevents accidental collisions.
- **Overlapping prefixes**. `/users` and `/users/me` must come from **different groups** (otherwise a double `.prefix` is impossible). Not a pitfall of the root contract per se, but this is where you notice it at runtime.
- **Missing `OpenApi.Title`**. Swagger will show a generic "API". Doesn't break anything, but the front-end client reading the OpenAPI doesn't know which doc it's in.
- **Export `type ApiType = typeof Api`**. **Always** export it — without it, every Live file has to do `typeof Api` itself, leaking the root implementation everywhere.

## Example

```ts
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "@effect/platform"
import { Schema } from "effect"
import { HttpApiGroupAuth } from "@template/auth/contract/AuthHttpApiGroup"
import { HttpApiGroupUsers } from "@template/api-contract/users/HttpApiGroupUsers"
// ... other group imports

// Small infra groups inline
export class HealthGroup extends HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("get", "/")
      .addSuccess(Schema.Struct({ status: Schema.Literal("ok") }))
  )
  .prefix("/health")
{}

export class VersionGroup extends HttpApiGroup.make("VersionGroup")
  .add(
    HttpApiEndpoint.get("version", "/")
      .addSuccess(Schema.Struct({ version: Schema.String }))
  )
  .prefix("/version")
{}

// Aggregation
export class Api extends HttpApi.make("api")
  .add(HealthGroup)
  .add(VersionGroup)
  .add(HttpApiGroupAuth)
  .add(HttpApiGroupUsers)
  // ... .add() per group
  .annotate(OpenApi.Title, "Groups API")
{}

// Exported type for the Live factories
export type ApiType = typeof Api
```

## Related

- http-api-contract — the individual groups added here
- http-server-live — the runtime counterpart that wires the corresponding Lives
