export async function register() {
  // Never dispatch jobs in a production build, tests, Edge or type generation.
  if (process.env.NEXT_RUNTIME !== "nodejs" || !process.argv.some((value) => value === "start" || value === "dev")) return;
  const { recoverProductProductionWorkers } = await import("@/lib/product-production-worker");
  const recover = () => {
    try { recoverProductProductionWorkers(); }
    catch { console.error("商品生产线恢复扫描失败，将在下一次扫描重试。"); }
  };
  const startup = setTimeout(recover, 3000);
  const timer = setInterval(recover, 30_000);
  startup.unref();
  timer.unref();
}
