// v20 requires each evidence-domain marker to be explicitly tied to a
// complete instruction before the server strips those temporary markers.
export const VIDEO_DIRECTOR_SCHEMA_VERSION = 20;

export const REQUIRED_VIDEO_DIRECTOR_HEADINGS = [
  "IMPORTANT",
  "SHOT PURPOSE",
  "CINEMATIC MOTION",
  "CAMERA DIRECTION",
  "LIGHTING AND TEXTURE",
  "PRODUCT CONSISTENCY LOCK",
  "CONTINUITY",
  "TRANSITION INTENT",
  "AUDIO AND TEXT",
  "NEGATIVE CONSTRAINTS",
] as const;

const CHANNEL_SPECIFIC_DIRECTOR_PATTERNS = [
  /VISUAL REFERENCE CONTRACTS?/i,
  /\bfive[- ]image\b/i,
  /\bfive visual references?\b/i,
  /\b(?:reference image|reference|image)\s*#?\s*[1-9]\b/i,
  /\b(?:grok|omni|seedance)\b/i,
  /\b(?:single|multi)[- ]reference\b/i,
  /\bimage_urls\b/i,
] as const;

export function videoDirectorHeadings(prompt: string) {
  return Array.from(prompt.matchAll(/^([A-Z][A-Z ]+):/gm), (match) => match[1].trim());
}

export function channelSpecificDirectorText(prompt: string) {
  return CHANNEL_SPECIFIC_DIRECTOR_PATTERNS.find((pattern) => pattern.test(prompt))?.source || "";
}

export function directorPromptRequiresAudio(prompt: string) {
  const audioSection = prompt.match(/AUDIO AND TEXT:\s*([\s\S]*?)(?=\nNEGATIVE CONSTRAINTS:|$)/i)?.[1] || "";
  return /[“"][^”"\n]+[”"]/.test(audioSection);
}
