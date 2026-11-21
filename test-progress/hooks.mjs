// Redirect the bare "react" import to a local stub so appStore.ts can be
// imported in plain Node without installing dependencies.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "react") {
    return { url: new URL("./react-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
