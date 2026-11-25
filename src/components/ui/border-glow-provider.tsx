"use client";

import { useEffect } from "react";
import "./border-glow.css";

const CARD_SELECTOR = [
  "[data-border-glow]",
  ".glass-card",
  ".luma-quick-cut-panel",
  ".luma-quick-cut-control-panel",
  ".luma-settings-page section.rounded-lg.border",
  ".luma-settings-page div.rounded-lg.border",
  ".luma-settings-page div.rounded-xl.border",
  ".luma-settings-page [data-slot='card']",
].join(", ");

const INTERACTIVE_SELECTOR = "button, a, input, textarea, select, summary, [role='button'], [role='tab']";

function getGlowTarget(eventTarget: EventTarget | null) {
  if (!(eventTarget instanceof Element)) return null;
  const candidate = eventTarget.closest(CARD_SELECTOR);
  if (!(candidate instanceof HTMLElement)) return null;
  if (candidate.matches(INTERACTIVE_SELECTOR) && !candidate.hasAttribute("data-border-glow")) return null;
  return candidate;
}

function getEdgeProximity(width: number, height: number, x: number, y: number) {
  const distanceToEdge = Math.min(x, y, width - x, height - y);
  return Math.min(Math.max(1 - distanceToEdge / 86, 0), 1);
}

function getCursorAngle(width: number, height: number, x: number, y: number) {
  const cx = width / 2;
  const cy = height / 2;
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 && dy === 0) return 0;
  const degrees = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
  return degrees < 0 ? degrees + 360 : degrees;
}

function getNearestEdgePoint(width: number, height: number, x: number, y: number) {
  const distances = [
    { edge: "left", value: x },
    { edge: "right", value: width - x },
    { edge: "top", value: y },
    { edge: "bottom", value: height - y },
  ].sort((a, b) => a.value - b.value);

  switch (distances[0]?.edge) {
    case "left":
      return { x: 0, y };
    case "right":
      return { x: width, y };
    case "top":
      return { x, y: 0 };
    case "bottom":
      return { x, y: height };
    default:
      return { x, y };
  }
}

export function BorderGlowProvider() {
  useEffect(() => {
    const media = window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 768px)");
    let activeCard: HTMLElement | null = null;
    let pointerFrame = 0;
    let pendingPointer: PointerEvent | null = null;

    const clearActiveCard = () => {
      if (!activeCard) return;
      activeCard.removeAttribute("data-border-glow-active");
      activeCard = null;
    };

    const setActiveCard = (card: HTMLElement) => {
      if (activeCard === card) return;
      clearActiveCard();
      activeCard = card;
      activeCard.setAttribute("data-border-glow-active", "true");
      if (!activeCard.style.getPropertyValue("--border-glow-radius")) {
        const radius = window.getComputedStyle(activeCard).borderTopLeftRadius;
        activeCard.style.setProperty("--border-glow-radius", radius || "12px");
      }
    };

    const processPointerMove = () => {
      pointerFrame = 0;
      const event = pendingPointer;
      pendingPointer = null;
      if (!event) return;

      if (!media.matches) {
        clearActiveCard();
        return;
      }

      const card = getGlowTarget(event.target);
      if (!card) {
        clearActiveCard();
        return;
      }

      const rect = card.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const edge = getNearestEdgePoint(rect.width, rect.height, x, y);
      const edgeStrength = getEdgeProximity(rect.width, rect.height, x, y);

      setActiveCard(card);
      card.style.setProperty("--border-glow-edge", `${(edgeStrength * 100).toFixed(3)}`);
      card.style.setProperty("--border-glow-opacity", edgeStrength.toFixed(3));
      card.style.setProperty("--border-glow-angle", `${getCursorAngle(rect.width, rect.height, x, y).toFixed(3)}deg`);
      card.style.setProperty("--border-glow-x", `${x.toFixed(1)}px`);
      card.style.setProperty("--border-glow-y", `${y.toFixed(1)}px`);
      card.style.setProperty("--border-glow-edge-x", `${edge.x.toFixed(1)}px`);
      card.style.setProperty("--border-glow-edge-y", `${edge.y.toFixed(1)}px`);
    };

    const onPointerMove = (event: PointerEvent) => {
      pendingPointer = event;
      if (!pointerFrame) pointerFrame = window.requestAnimationFrame(processPointerMove);
    };

    const onPointerOut = (event: PointerEvent) => {
      if (!activeCard) return;
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Node && activeCard.contains(nextTarget)) return;
      clearActiveCard();
    };

    const onMediaChange = () => {
      if (!media.matches) clearActiveCard();
    };

    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerout", onPointerOut, { passive: true });
    media.addEventListener("change", onMediaChange);

    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerout", onPointerOut);
      media.removeEventListener("change", onMediaChange);
      if (pointerFrame) window.cancelAnimationFrame(pointerFrame);
      pendingPointer = null;
      clearActiveCard();
    };
  }, []);

  return null;
}
