// Lets Node import the project's TypeScript files in tests: the source imports "./board" without a file
// extension, which plain Node does not resolve. This hook tries "./board.ts" instead.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith("./") && !/\.[a-z]+$/.test(specifier)) {
    try {
      return await next(specifier + ".ts", context);
    } catch {
      // not a .ts file; fall through to the default resolution
    }
  }
  return next(specifier, context);
}
