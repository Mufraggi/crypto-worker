import { HttpRouter, HttpServer, HttpServerResponse } from "@effect/platform"
import { NodeHttpServer } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { createServer } from "node:http"

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/health", HttpServerResponse.json({ status: "ok" }))
)

const app = router.pipe(
  HttpServer.serve()
)

const HealthServerLayer = app.pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 8081 }))
)

export const runHealthServer = Layer.launch(HealthServerLayer).pipe(
  Effect.tap(() => Effect.log("🏥 Health check server started on port 8081")),
  Effect.forkDaemon
)
