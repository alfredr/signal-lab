// Reading thrown values without trusting their type: anything can be thrown, so these check
// shapes rather than classes.

const field = (error: unknown, key: "name" | "message"): string | undefined =>
  typeof error === "object" && error !== null && key in error ? String((error as Record<string, unknown>)[key]) : undefined;

/** The error's name, such as "RateError", if it has one. */
export function errorName(error: unknown): string | undefined {
  return field(error, "name");
}

export function errorMessage(error: unknown): string {
  return field(error, "message") ?? String(error);
}
