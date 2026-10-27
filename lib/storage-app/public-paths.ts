/**
 * The EXACT /api/storage-app routes the gatekeeper (middleware.ts) lets through without a browser cookie — the Mac app has none; every
 * one of them authenticates itself (the token route by its one-time code / refresh token, the rest by `withDevice`, which fails closed).
 * Never a prefix: a prefix would make every future route under it public AND skip the CRM's two-step-login check.
 * tests/unit/storage-app-routes.test.ts keeps this list, the route files and the gatekeeper in step.
 */
export const STORAGE_APP_PUBLIC_PATHS: readonly string[] = [
  "/api/storage-app/token",
  "/api/storage-app/whoami",
  "/api/storage-app/navigation",
  "/api/storage-app/folder",
  "/api/storage-app/changes",
  "/api/storage-app/item",
  "/api/storage-app/file",
  "/api/storage-app/upload-slot",
  "/api/storage-app/save",
]

/**
 * The only routes outside /api/storage-app that are public: the update feed (no client data; the app installs only what our key signed) and the build machine's `stage` door (bearer token, can only store a signed version PAUSED).
 * Exact path, same reasoning as above. tests/unit/storage-app-release.test.ts keeps it in step with the route file.
 */
export const STORAGE_APP_RELEASE_PUBLIC_PATHS: readonly string[] = ["/api/storage-app-release/appcast.xml", "/api/storage-app-release/stage"]
