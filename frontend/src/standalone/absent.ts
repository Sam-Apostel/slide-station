// What `@/standalone/*` resolves to in the regular (server) build: the browser engine is only
// reachable behind `standalone`, so nothing here is ever called — this keeps it out of the bundle.
export {};
