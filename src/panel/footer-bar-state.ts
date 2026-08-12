/**
 * Pure logic for the Save button's disabled state.
 *
 * Extracted from FooterBar so it can be unit-tested without a React renderer.
 *
 * Rules:
 * - Enabled when the plugin is unconfigured (configuration was null or
 *   undefined at mount), so the user can request the defaults.
 * - Enabled when the working state differs from the last-requested snapshot
 *   (dirty), so a pending edit can always be committed.
 * - Disabled otherwise: a configured plugin with no pending edits has
 *   nothing to save.
 */

/**
 * Returns true when the Save button should be disabled.
 *
 * @param dirty - Whether the working state differs from the last requested snapshot.
 * @param unconfigured - Whether the host supplied no configuration at mount.
 */
export function saveButtonDisabled (dirty: boolean, unconfigured: boolean): boolean {
  return !dirty && !unconfigured
}
