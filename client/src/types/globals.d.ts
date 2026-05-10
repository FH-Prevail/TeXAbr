// Browser-side type shims for Openotex code that was originally compiled
// against @types/node. Defining the bits we actually use lets us keep the
// Openotex source unchanged without pulling all of node's globals into
// browser code.

declare namespace NodeJS {
  type Timeout = ReturnType<typeof setTimeout>;
}

// Vite's `?url` and `?raw` import suffixes — declare them so tsc accepts the
// imports that Vite resolves at build time.
declare module "*?url" {
  const url: string;
  export default url;
}
declare module "*?raw" {
  const raw: string;
  export default raw;
}
