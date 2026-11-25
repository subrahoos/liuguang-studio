export const IDENTITY_PERFORMANCE_BASELINE_VERSION = "2026-07-23.1";

export const identityPhysicalLockText = [
  "Keep the same face shape, facial features, hairstyle, skin tone, body proportion, height impression, shoulder width, limb proportion, and clean real-person skin texture across all generated assets and videos.",
  "Identity references lock physical identity only; product clothing must come from the selected product package.",
].join(" ");

export const identityPerformanceBaselineText = [
  "When the person's face is clearly visible, keep a real human presence appropriate to the observed current shot. Do not impose an alert, attentive, friendly, smiling, or direct-to-camera state that the current shot does not show.",
  "Identity references lock facial geometry and identity, not the neutral expression, direct-lens gaze, or closed-mouth state shown in a calibration image.",
  "Observable current-shot performance evidence overrides every generic neutral-expression, gaze, mouth, smile, eye-catchlight, or no-speech default in this baseline and in an identity expression board.",
  "Follow the current shot's specified gaze target, expression, mouth state, action, and speech rhythm. Coordinate eyes, brows, cheeks, mouth, head direction, hand action, and product proof around the same attention target.",
  "Use a plausible natural eye catchlight only when open eyes and a visible or physically credible light source make it appropriate. Do not force a catchlight, micro-expression, or direct-lens gaze in a profile, back view, occluded face, closed eye, distant shot, or incompatible lighting.",
  "When current-shot performance evidence is absent, avoid vacant or glassy eyes, doll-like or frozen symmetry, purposeless eye darting, repeated blinking, constant smiling, exaggerated brow motion, theatrical acting, and speech-like mouth motion when no speech is specified.",
].join(" ");

export type IdentityAuxiliaryPanelLike = {
  order?: unknown;
  label?: unknown;
  sourceKind?: unknown;
};

const expressionPanelDirections: Record<string, string> = {
  expression_neutral: "friendly opening with a gentle closed-mouth smile",
  expression_smile: "warm sharing with a genuine visible-teeth smile",
  expression_bright_smile: "focused explanation with steady gaze and lightly engaged brows",
  expression_turn_back: "key-point emphasis with alert brows and a natural speaking mouth",
  expression_gesture: "interactive question with subtle one-brow asymmetry and a small questioning mouth",
  expression_walk: "restrained surprise with raised brows, wider eyes, and a small rounded mouth",
};

function panelOrder(value: unknown, fallback: number) {
  const order = Number(value);
  return Number.isFinite(order) && order > 0 ? Math.round(order) : fallback;
}

export function identityAuxiliaryPanelText(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const panel = item as IdentityAuxiliaryPanelLike;
      const sourceKind = String(panel.sourceKind || "").trim();
      const mappedDirection = expressionPanelDirections[sourceKind];
      const label = String(panel.label || "").trim();
      const direction = mappedDirection || (label ? `the labelled state \"${label}\"` : "the labelled panel state");
      return { order: panelOrder(panel.order, index + 1), direction };
    })
    .filter((panel): panel is { order: number; direction: string } => Boolean(panel))
    .sort((left, right) => left.order - right.order)
    .map((panel) => `Panel ${String(panel.order).padStart(2, "0")}: ${panel.direction}.`)
    .join(" ");
}
