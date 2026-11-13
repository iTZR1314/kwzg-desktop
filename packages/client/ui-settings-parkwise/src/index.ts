/**
 * ParkWise settings & plugin UI, node half: empty apply so the package owns a
 * Loader row for the client module system while the browser half registers into
 * `settings.section` and `plugins.item`.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
