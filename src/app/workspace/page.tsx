"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LumaWorkspaceDashboard } from "@/components/luma-workspace-dashboard";
import { fetchWorkspaceSession, logoutWorkspace } from "@/lib/workspace-auth";

export default function WorkspacePage() {
  const router = useRouter();
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchWorkspaceSession()
        .then((session) => {
          if (!session) {
            router.replace(`/login?from=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`);
            return;
          }
          setIsReady(true);
        })
        .catch(() => router.replace(`/login?from=${encodeURIComponent(`${window.location.pathname}${window.location.search}`)}`));
    }, 0);

    return () => window.clearTimeout(timer);
  }, [router]);

  async function logout() {
    await logoutWorkspace();
    router.replace("/");
  }

  if (!isReady) {
    return (
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden text-slate-100">
        <p className="relative z-10 rounded-full border border-white/10 bg-white/[0.05] px-5 py-2 text-sm text-cyan-100 backdrop-blur-2xl">
          正在验证工作台权限...
        </p>
      </main>
    );
  }

  return (
    <main className="relative h-screen overflow-hidden text-slate-100">
      <div className="relative z-10">
        <LumaWorkspaceDashboard onLogout={logout} />
      </div>
    </main>
  );
}
