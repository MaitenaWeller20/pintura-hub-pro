/** A failed lazy route import needs a new document and module map to retry. */
export function isDynamicImportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(
      error.message,
    )
  );
}
