"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, House, LockKeyhole, Sparkles, UserPlus } from "lucide-react";
import { fetchWorkspaceSession, loginWorkspace, registerWorkspace } from "@/lib/workspace-auth";

type Mode = "login" | "register";

function LoginPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [registeredAccountId, setRegisteredAccountId] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const requestedPath = searchParams.get("from");
  const returnPath = requestedPath && requestedPath.startsWith("/") && !requestedPath.startsWith("//")
    ? requestedPath
    : "/workspace";

  useEffect(() => {
    void fetchWorkspaceSession()
      .then((session) => {
        if (session) router.replace(returnPath);
      })
      .catch(() => null);
  }, [returnPath, router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      if (mode === "login") {
        await loginWorkspace(username, password);
        router.push(returnPath);
      } else {
        const result = await registerWorkspace({ username, password, inviteCode });
        setRegisteredAccountId(String(result.user?.accountId || ""));
      }
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "操作失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="luma-login-page relative min-h-screen overflow-x-hidden overflow-y-auto bg-transparent text-slate-100">
      <header className="relative z-20 flex h-20 items-center justify-between px-5 sm:px-6 lg:px-8">
        <Link href="/" className="flex w-[214px] flex-col items-start leading-none">
          <span className="whitespace-nowrap text-[12px] font-medium uppercase tracking-[0.18em] text-cyan-100/70">Luma Commerce Studio</span>
          <span className="mt-1 bg-gradient-to-r from-cyan-100 via-white to-violet-300 bg-clip-text text-2xl font-black tracking-tight text-transparent">
            流光商影
          </span>
        </Link>
        <Link
          href="/"
          className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.06] text-cyan-100 shadow-[0_0_24px_rgba(34,211,238,0.08)] backdrop-blur-2xl transition hover:border-cyan-200/45 hover:bg-cyan-200/10"
          title="返回首页"
        >
          <House className="h-4 w-4" />
        </Link>
      </header>

      <section className="relative z-10 grid min-h-[calc(100vh-5rem)] grid-cols-1 items-start gap-10 px-6 py-8 pb-14 lg:items-center lg:grid-cols-[minmax(0,1fr)_400px] lg:px-8 lg:py-10 xl:px-10">
        <div className="max-w-[760px] justify-self-start lg:pl-[3vw] xl:pl-[5vw]">
          <p className="mb-7 inline-flex items-center gap-2 rounded-full border border-cyan-100/14 bg-white/[0.05] px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-cyan-100/85 backdrop-blur-2xl">
            <Sparkles className="h-3.5 w-3.5" />
            Secure Creative Workspace
          </p>
          <h1 className="bg-gradient-to-br from-cyan-100 via-white to-violet-300 bg-clip-text text-[clamp(2.2rem,4vw,4rem)] font-black leading-[1.08] tracking-tight text-transparent drop-shadow-[0_0_46px_rgba(125,211,252,0.23)]">
            流程交给我们
            <br />
            <span className="whitespace-nowrap">让创作忠于你的灵感</span>
          </h1>
          <p className="mt-8 max-w-2xl text-base leading-8 text-slate-200/74 md:text-lg">
            把素材、参考与方法沉淀为清晰的创作链路，让灵感从发现到成片都能被安全保存、独立运行。
          </p>
          <div className="mt-10 inline-flex items-center gap-3 rounded-full border border-emerald-200/14 bg-emerald-300/8 px-4 py-2.5 text-sm text-emerald-100/88 shadow-[0_0_32px_rgba(52,211,153,0.08)] backdrop-blur-2xl">
            <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_16px_rgba(110,231,183,0.9)]" />
            本地账号系统已启用
          </div>
        </div>

        <form
          onSubmit={handleSubmit}
          autoComplete={mode === "register" ? "off" : "on"}
          data-border-glow
          className="relative w-full max-w-[400px] justify-self-center overflow-hidden rounded-lg border border-white/16 bg-[#071116]/20 p-5 text-slate-100 shadow-[0_30px_120px_rgba(0,0,0,0.46)] backdrop-blur-3xl lg:justify-self-end lg:mr-[3vw] xl:mr-[4vw]"
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_0%,rgba(103,232,249,0.14),transparent_34%),radial-gradient(circle_at_86%_18%,rgba(167,139,250,0.12),transparent_38%),linear-gradient(135deg,rgba(255,255,255,0.045),rgba(255,255,255,0.01))]" />
          <div className="pointer-events-none absolute inset-px rounded-lg border border-white/[0.06]" />
          <div className="relative">
            <div className="mb-7 flex items-center gap-4 border-b border-white/10 pb-5">
              <div className="flex h-12 w-12 items-center justify-center rounded-full border border-cyan-200/25 bg-cyan-200/10 text-cyan-100 shadow-[0_0_28px_rgba(34,211,238,0.16)]">
                {mode === "login" ? <LockKeyhole className="h-5 w-5" /> : <UserPlus className="h-5 w-5" />}
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-50">{mode === "login" ? "登录工作台" : "用户注册"}</h2>
                <p className="mt-1 text-xs font-medium uppercase tracking-[0.2em] text-cyan-100/56">
                  {mode === "login" ? "AI Creative Engine" : "Invite Access"}
                </p>
              </div>
            </div>

            <div className="mb-5 rounded-lg border border-white/10 bg-white/[0.035] p-4 backdrop-blur-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.26em] text-violet-200/70">Identity Verification</p>
              <p className="mt-3 text-sm leading-6 text-slate-300/68">
                {mode === "login" ? "使用用户名或账户 ID 进入独立创作空间。" : "邀请码由管理员生成，账户 ID 注册后自动分配。"}
              </p>
            </div>

            {registeredAccountId ? (
              <div className="space-y-4">
                <div className="rounded-lg border border-emerald-200/20 bg-emerald-200/[0.08] p-4 text-center">
                  <p className="text-sm font-semibold text-emerald-100">账户创建成功</p>
                  <p className="mt-3 text-xs text-slate-300/70">你的账户 ID</p>
                  <p className="mt-1 text-xl font-bold tracking-wide text-cyan-100">{registeredAccountId}</p>
                </div>
                <button
                  type="button"
                  onClick={() => router.push("/workspace")}
                  className="group flex h-14 w-full items-center justify-center gap-3 rounded-lg border border-cyan-100/20 bg-cyan-200/12 text-base font-bold text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_44px_rgba(34,211,238,0.11)] backdrop-blur-2xl transition hover:border-cyan-100/45 hover:bg-cyan-200/18"
                >
                  进入工作台
                  <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" />
                </button>
              </div>
            ) : (
              <>
                <label className="mb-5 block">
                  <span className="mb-2 block text-sm font-medium text-slate-200/78">{mode === "login" ? "用户名或账户 ID" : "用户名"}</span>
                  <input
                    name={mode === "login" ? "login-identity" : "registration-username"}
                    value={username}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder={mode === "login" ? "例如：admin 或 LUMA-000001" : "设置 2-32 位用户名"}
                    className="h-14 w-full rounded-lg border border-white/10 bg-black/18 px-4 text-base font-semibold text-slate-50 outline-none transition placeholder:text-slate-500 focus:border-cyan-200/55 focus:bg-black/28 focus:ring-4 focus:ring-cyan-200/10"
                    autoComplete={mode === "login" ? "username" : "off"}
                  />
                </label>

                <label className="mb-5 block">
                  <span className="mb-2 block text-sm font-medium text-slate-200/78">{mode === "login" ? "密码" : "设置密码"}</span>
                  <input
                    name={mode === "login" ? "login-password" : "registration-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    type="password"
                    placeholder={mode === "login" ? "输入密码" : "至少 6 位"}
                    className="h-14 w-full rounded-lg border border-white/10 bg-black/18 px-4 text-base font-semibold text-slate-50 outline-none transition placeholder:text-slate-500 focus:border-cyan-200/55 focus:bg-black/28 focus:ring-4 focus:ring-cyan-200/10"
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                  />
                </label>

                {mode === "register" && (
                  <label className="mb-5 block">
                    <span className="mb-2 block text-sm font-medium text-slate-200/78">邀请码</span>
                    <input
                      name="registration-invite-code"
                      value={inviteCode}
                      onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
                      placeholder="输入管理员提供的邀请码"
                      className="h-14 w-full rounded-lg border border-white/10 bg-black/18 px-4 text-base font-semibold uppercase tracking-[0.08em] text-slate-50 outline-none transition placeholder:text-slate-500 focus:border-cyan-200/55 focus:bg-black/28 focus:ring-4 focus:ring-cyan-200/10"
                      autoComplete="off"
                    />
                  </label>
                )}

                {error && <p className="mb-5 rounded-md border border-rose-300/18 bg-rose-300/10 px-3 py-2 text-sm text-rose-100">{error}</p>}

                <button
                  type="submit"
                  disabled={submitting}
                  className="group flex h-14 w-full items-center justify-center gap-3 rounded-lg border border-cyan-100/20 bg-cyan-200/12 text-base font-bold text-cyan-50 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_0_44px_rgba(34,211,238,0.11)] backdrop-blur-2xl transition hover:border-cyan-100/45 hover:bg-cyan-200/18 hover:shadow-[0_0_54px_rgba(34,211,238,0.2)] disabled:cursor-wait disabled:opacity-60"
                >
                  {submitting ? "处理中..." : mode === "login" ? "安全登录" : "完成注册"}
                  <ArrowRight className="h-5 w-5 transition group-hover:translate-x-1" />
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === "login" ? "register" : "login");
                    setUsername("");
                    setPassword("");
                    setInviteCode("");
                    setError("");
                  }}
                  className="mt-3 flex h-12 w-full items-center justify-center rounded-lg border border-white/10 bg-white/[0.045] text-sm font-semibold text-slate-200 transition hover:border-cyan-100/28 hover:bg-cyan-200/10 hover:text-cyan-50"
                >
                  {mode === "login" ? "用户注册" : "返回安全登录"}
                </button>
              </>
            )}

            <p className="mt-6 text-xs leading-6 text-slate-400/80">
              会话由服务器 Cookie 管理。退出登录后会回到首页展示页，并清除工作台访问权限。
            </p>
          </div>
        </form>
      </section>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="luma-login-page min-h-screen bg-transparent" />}>
      <LoginPageContent />
    </Suspense>
  );
}
