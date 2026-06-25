# Crypto Worker - Worker App

Process worker : démarre le moteur de cluster (`@effect/cluster` / `@effect/workflow`),
enregistre les workflows et expose un health check.

- `src/Health/HttpServer.ts` — `GET /health` (port 8081).
- `src/main.ts` — câblage cluster (`RunnerLayer`, `BaseDependenciesLayer`, `ClusterEngineLayer`)
  et agrégation des workflows dans `MainLayer`.

## Lancer en local

```bash
pnpm --filter @template/worker start   # nécessite un .env valide (cf. .env.example)
curl localhost:8081/health             # => {"status":"ok"}
```
