export const UNIVERSAL_PRODUCT_LOCK = [
  "Universal product lock:",
  "Preserve the product's exact shape, size, proportions, structure, silhouette, edges, seams, openings, surface texture, material behavior, color blocks, printed patterns, logo/label placement, decorative details, and all visible front/side/back features from the product references.",
  "Do not stretch, shrink, lengthen, shorten, simplify, replace, redesign, recolor, invent, remove, or add any product part across shots, actions, or viewing angles.",
  "If front, side, and back product references are provided, treat them as three views of the same physical product, not separate product designs.",
].join(" ");

export const GARMENT_PRODUCT_LOCK = [
  "If the product is a garment:",
  "Preserve front/back length, hem line, side seams, neckline/collar, sleeve shape, cuff/opening, shoulder line, waist/hip coverage, fabric drape, texture, trims, buttons, pockets, pattern placement, and fit across front, side, and back views.",
  "Do not create a longer rear hem, tail hem, high-low cut, dress-like flap, skirt-like back layer, cape, apron, or extra fabric panel unless it is clearly visible in the uploaded garment references.",
].join(" ");

export const VIDEO_SHOT_STABILITY_LOCK = [
  "Shot stability lock:",
  "Use one clean camera progression per clip.",
  "Do not morph, dissolve, ghost, double expose, or overlay the subject/product when changing shot size.",
  "Hands must physically touch the exact product area being described and pause briefly after each proof action.",
].join(" ");

export function withUniversalProductLock(prompt: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return trimmed;
  if (/Universal product lock:/i.test(trimmed)) return trimmed;
  return [
    trimmed,
    UNIVERSAL_PRODUCT_LOCK,
    GARMENT_PRODUCT_LOCK,
    VIDEO_SHOT_STABILITY_LOCK,
  ].join("\n\n");
}
