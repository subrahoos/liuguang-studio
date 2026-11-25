/** Internal transport preference for OpenAI-compatible image providers. */
export const IMAGE_RESPONSE_FORMAT = "b64_json";
/**
 * Time allowed to receive the first upstream response. A 4K image can take
 * several minutes before the provider sends response headers.
 */
export const IMAGE_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Base64 responses are large. Once headers arrive, allow a fresh bounded
 * window to download and persist the complete image payload.
 */
export const IMAGE_RESPONSE_BODY_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Once response headers arrive, abort only when the body makes no progress
 * for this long. The timer resets after every received chunk, so a large but
 * continuously transferring Base64 payload is not mistaken for a failure.
 */
export const IMAGE_RESPONSE_BODY_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const IMAGE_REFERENCE_TARGET_BYTES = 2.2 * 1024 * 1024;
