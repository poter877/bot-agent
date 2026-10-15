import { serve } from '@hono/node-server'
import { createWorkerApp } from './app.js'
import { loadWorkerConfig } from './config.js'
import { DockerCloudWorker } from './docker-worker.js'

const config = loadWorkerConfig()
const app = createWorkerApp(config, new DockerCloudWorker(config))
const server = serve({ fetch: app.fetch, hostname: config.CLOUD_WORKER_HOST, port: config.CLOUD_WORKER_PORT })
console.info(`Cloud computer worker listening on ${config.CLOUD_WORKER_HOST}:${config.CLOUD_WORKER_PORT}`)

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 31_000).unref()
}
process.once('SIGTERM', stop)
process.once('SIGINT', stop)
