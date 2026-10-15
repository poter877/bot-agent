export class WorkerError extends Error {
  constructor(readonly status: 400 | 401 | 404 | 409 | 429 | 503, readonly code: string, message: string) {
    super(message)
  }
}
