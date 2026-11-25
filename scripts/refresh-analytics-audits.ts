import { readFile } from "fs/promises";
import { eq } from "drizzle-orm";
import { parseAnalyticsWorkbook } from "@/lib/analytics/workbook-parser";
import { resolveAnalyticsImportFilePath } from "@/lib/analytics/service";
import { getDb } from "@/lib/db";
import {
  analyticsAuditLogs,
  analyticsFormulaAudits,
  analyticsImports,
  analyticsReconciliations,
  analyticsSheetAudits,
} from "@/lib/db/schema";

function chunks<T>(items: T[], size = 500) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

async function refreshBatch(importId: string) {
  const db = getDb();
  const [batch] = await db.select().from(analyticsImports).where(eq(analyticsImports.id, importId)).limit(1);
  if (!batch) throw new Error(`利润表批次不存在: ${importId}`);
  const parsed = parseAnalyticsWorkbook(await readFile(resolveAnalyticsImportFilePath(batch.ownerId, batch.filePath)));

  await db.delete(analyticsSheetAudits).where(eq(analyticsSheetAudits.importId, importId));
  await db.delete(analyticsFormulaAudits).where(eq(analyticsFormulaAudits.importId, importId));
  await db.delete(analyticsReconciliations).where(eq(analyticsReconciliations.importId, importId));
  for (const chunk of chunks(parsed.sheetAudits)) {
    await db.insert(analyticsSheetAudits).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row })));
  }
  for (const chunk of chunks(parsed.formulaAudits)) {
    await db.insert(analyticsFormulaAudits).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row })));
  }
  for (const chunk of chunks(parsed.reconciliations)) {
    await db.insert(analyticsReconciliations).values(chunk.map((row) => ({ id: crypto.randomUUID(), importId, ownerId: batch.ownerId, ...row })));
  }
  await db.update(analyticsImports).set({
    stage: "已按最新校验规则复核",
    productProfitTotal: parsed.productProfitTotal,
    cachedProductProfitTotal: parsed.cachedProductProfitTotal,
    reconciliationStatus: parsed.reconciliationStatus,
    formulaCount: parsed.formulaCount,
    formulaErrorCount: parsed.formulaErrorCount,
    fixedRangeRiskCount: parsed.fixedRangeRiskCount,
  }).where(eq(analyticsImports.id, importId));
  await db.insert(analyticsAuditLogs).values({
    id: crypto.randomUUID(),
    actorId: batch.createdBy,
    ownerId: batch.ownerId,
    importId,
    action: "analytics.audit.refreshed",
    detail: {
      formulaErrorCount: parsed.formulaErrorCount,
      fixedRangeRiskCount: parsed.fixedRangeRiskCount,
      reconciliationStatus: parsed.reconciliationStatus,
    },
  });
  return { id: batch.id, fileName: batch.fileName, formulaErrorCount: parsed.formulaErrorCount, reconciliationStatus: parsed.reconciliationStatus };
}

async function main() {
  const db = getDb();
  const completed = await db.select({ id: analyticsImports.id })
    .from(analyticsImports)
    .where(eq(analyticsImports.status, "completed"));
  const results = [];
  for (const batch of completed) results.push(await refreshBatch(batch.id));
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
