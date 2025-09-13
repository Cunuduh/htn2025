export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  cause?: unknown;
  code?: string;
  meta?: Record<string, unknown>;
}

// Basic heuristic to detect safe exposure in development only.
function allowStack(debug: boolean): boolean {
  if (!debug) return false;
  return process.env.NODE_ENV !== 'production';
}

export function serializeError(err: unknown, debug = false): SerializedError {
  if (err instanceof Error) {
    // Extend the base Error with optional fields we may want to surface.
    interface LooseError extends Error {
      code?: string;
      cause?: unknown;
    }
    const le = err as LooseError;
    return {
      message: err.message,
      name: err.name,
      stack: allowStack(debug) ? err.stack : undefined,
      code: le.code,
      // Keep cause minimal to avoid circular refs; if object, omit.
      cause: (typeof le.cause === 'object') ? undefined : le.cause,
    };
  }
  return { message: typeof err === 'string' ? err : 'Unknown error' };
}

export function errorResponse(error: unknown, debug = false, init?: ResponseInit) {
  const body = { error: serializeError(error, debug) };
  return Response.json(body, { status: 500, ...init });
}
