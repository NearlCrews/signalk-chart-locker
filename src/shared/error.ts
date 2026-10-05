/** The message of a caught value, for a log line or a status sentence. Anything thrown that is not an
 * Error is stringified. */
export function errorMessage (error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
