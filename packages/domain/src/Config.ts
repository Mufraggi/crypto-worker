import { PlatformConfigProvider } from "@effect/platform"
import { NodeContext } from "@effect/platform-node"
import { Layer } from "effect"
import * as path from "node:path"

/**
 * Charge la configuration depuis un fichier `.env` à la racine du process.
 * Provisionné par `NodeContext.layer` (accès FileSystem/Path).
 */
export const ConfigLive = PlatformConfigProvider
  .layerDotEnv(path.join(process.cwd(), ".env"))
  .pipe(Layer.provide(NodeContext.layer))
