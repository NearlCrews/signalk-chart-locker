/**
 * The OCI image tag rule for the tile cache container image, shared by the plugin's configuration
 * validation and the panel's field. The field bounds its input with the same number the validator
 * enforces, so it cannot accept text the plugin then rejects with a message that says nothing about
 * length.
 */

/** The longest container image tag the plugin accepts, which is the OCI tag limit. */
export const MAX_IMAGE_TAG_LENGTH = 128

// One leading alphanumeric or underscore, then the rest of the tag up to the shared bound.
const IMAGE_TAG_PATTERN = new RegExp(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,${String(MAX_IMAGE_TAG_LENGTH - 1)}}$`)

/** Whether a non-blank container image tag is a valid OCI tag within the shared length bound. */
export function isValidImageTag (tag: string): boolean {
  return IMAGE_TAG_PATTERN.test(tag)
}
