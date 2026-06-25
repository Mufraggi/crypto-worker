# Crypto Worker - Database Package

Connexion PostgreSQL (`PgLive`), modèles (`Model.Class`) et repositories (`Effect.Service`).

## Conventions

- `src/Sql.ts` — layer `PgLive` (pool, transformation camelCase ↔ snake_case).
- `src/models/<Name>Model.ts` — un `Model.Class` par table.
- `src/repository/<Name>Repository.ts` — un `Effect.Service` par entité, basé sur `Model.makeRepository`, dépend de `PgLive`.
