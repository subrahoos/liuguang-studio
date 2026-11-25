import type { Metadata } from "next";
import { LumaAuthSettingsBridge } from "@/components/luma-auth-settings-bridge";
import { LumaGlobalBackground } from "@/components/luma-global-background";
import { BorderGlowProvider } from "@/components/ui/border-glow-provider";
import "./globals.css";
import "./board-visual-overrides.css";

export const metadata: Metadata = {
  title: "流光商影 - AI 电商视频生产中枢",
  description: "把爆款参考、商品素材与 AI 视频生产汇入一条创作流水线。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-[#071011] text-foreground">
        <LumaGlobalBackground />
        <LumaAuthSettingsBridge />
        <BorderGlowProvider />
        <div className="relative z-10 min-h-screen">
          {children}
        </div>
      </body>
    </html>
  );
}
