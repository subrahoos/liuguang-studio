import { readFile } from "fs/promises";
import { basename, resolve } from "path";
import { importAnalyticsWorkbook } from "@/lib/analytics/service";

async function main() {
  const [fileArgument, ownerId = "luma-admin", actorId = ownerId] = process.argv.slice(2);
  if (!fileArgument) throw new Error("用法: tsx scripts/import-analytics-workbook.ts <利润表.xlsx> [ownerId] [actorId]");
  const filePath = resolve(fileArgument);
  const result = await importAnalyticsWorkbook({
    ownerId,
    actorId,
    fileName: basename(filePath),
    buffer: await readFile(filePath),
  });
  process.stdout.write(JSON.stringify({
    importId: result.importId,
    periodStart: result.periodStart,
    periodEnd: result.periodEnd,
    storeCount: result.storeCount,
    productCount: result.productCount,
    sourceOrderRows: result.sourceOrderRows,
    reconciliationStatus: result.reconciliationStatus,
  }, null, 2));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
