"use client";

import { usePathname } from "next/navigation";
import { HomeBackground, useHomeBackgroundSettings } from "@/components/luma-home-background";

export function LumaGlobalBackground() {
  const pathname = usePathname();
  const background = useHomeBackgroundSettings();
  const overlay =
    pathname === "/"
      ? background.settings.overlay
      : pathname === "/login"
        ? Math.max(background.settings.overlay, 0.42)
        : Math.max(background.settings.overlay, 0.52);

  return (
    <div className="fixed inset-0 z-0 bg-[#071011]" aria-hidden="true">
      {background.isReady && (
        <HomeBackground
          settings={{
            ...background.settings,
            overlay,
            blur: pathname === "/" ? background.settings.blur : Math.max(background.settings.blur, 1),
          }}
        />
      )}
    </div>
  );
}
