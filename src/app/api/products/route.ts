import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { handleAuthRouteError, requireUser } from "@/lib/auth";

export const runtime = "nodejs";

const PRODUCT_CATEGORIES = new Set(["beauty", "food", "home", "fashion", "tech", "other"]);

type ProductCategory = "beauty" | "food" | "home" | "fashion" | "tech" | "other";

type ProductInput = {
  id?: string;
  name?: string;
  category?: ProductCategory;
  description?: string;
  images?: string[];
  price?: string;
  targetAudience?: string;
  usageScenarios?: string;
  negativeConstraints?: string;
  videoCount?: number;
  createdAt?: string | number | Date;
};

function cleanText(value: unknown, maxLength = 8000) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanImages(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
}

function validId(value: unknown) {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,100}$/.test(value) ? value : "";
}

function normalizeProduct(value: unknown, options: { requireId?: boolean } = {}) {
  const input = (value && typeof value === "object" ? value : {}) as ProductInput;
  const id = validId(input.id);
  const name = cleanText(input.name, 120);
  const category = PRODUCT_CATEGORIES.has(input.category || "") ? input.category as ProductCategory : "other";
  const images = cleanImages(input.images);
  if (options.requireId && !id) throw new Error("商品 ID 无效");
  if (!name) throw new Error("请填写商品名称");
  if (images.length === 0) throw new Error("请至少保留一张商品图");

  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  return {
    id: id || crypto.randomUUID(),
    name,
    category,
    description: cleanText(input.description) || null,
    images,
    price: cleanText(input.price, 120) || null,
    targetAudience: cleanText(input.targetAudience, 2000) || null,
    usageScenarios: cleanText(input.usageScenarios, 4000) || null,
    negativeConstraints: cleanText(input.negativeConstraints, 4000) || null,
    videoCount: Number.isFinite(input.videoCount) ? Math.max(0, Math.floor(Number(input.videoCount))) : 0,
    createdAt: Number.isNaN(createdAt.getTime()) ? new Date() : createdAt,
  };
}

function toPublicProduct(row: typeof products.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description || undefined,
    images: Array.isArray(row.images) ? row.images : [],
    price: row.price || undefined,
    targetAudience: row.targetAudience || undefined,
    usageScenarios: row.usageScenarios || undefined,
    negativeConstraints: row.negativeConstraints || undefined,
    videoCount: row.videoCount || 0,
    createdAt: row.createdAt || new Date(),
  };
}

async function readOwnedProduct(userId: string, productId: string) {
  const [product] = await getDb()
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.ownerId, userId)))
    .limit(1);
  return product;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const rows = await getDb()
      .select()
      .from(products)
      .where(eq(products.ownerId, user.id))
      .orderBy(desc(products.updatedAt), desc(products.createdAt));
    return NextResponse.json({ products: rows.map(toPublicProduct) });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "读取商品库失败" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const inputs = Array.isArray(body.products) ? body.products : [body.product ?? body];
    if (inputs.length === 0 || inputs.length > 100) return NextResponse.json({ error: "商品数量无效" }, { status: 400 });

    const created = [];
    const now = new Date();
    for (const raw of inputs) {
      const product = normalizeProduct(raw);
      const existing = await readOwnedProduct(user.id, product.id);
      if (existing) {
        created.push(toPublicProduct(existing));
        continue;
      }
      await getDb().insert(products).values({
        ...product,
        ownerId: user.id,
        updatedAt: now,
      });
      const saved = await readOwnedProduct(user.id, product.id);
      if (saved) created.push(toPublicProduct(saved));
    }

    return NextResponse.json({ product: created[0], products: created }, { status: 201 });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "保存商品失败" },
      { status: 500 },
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const id = validId(body.id);
    if (!id) return NextResponse.json({ error: "商品 ID 无效" }, { status: 400 });
    const existing = await readOwnedProduct(user.id, id);
    if (!existing) return NextResponse.json({ error: "商品不存在或无权访问" }, { status: 404 });

    const product = normalizeProduct({ ...body.product, id, createdAt: existing.createdAt }, { requireId: true });
    await getDb().update(products).set({
      name: product.name,
      category: product.category,
      description: product.description,
      images: product.images,
      price: product.price,
      targetAudience: product.targetAudience,
      usageScenarios: product.usageScenarios,
      negativeConstraints: product.negativeConstraints,
      videoCount: product.videoCount,
      updatedAt: new Date(),
    }).where(and(eq(products.id, id), eq(products.ownerId, user.id)));

    const saved = await readOwnedProduct(user.id, id);
    return NextResponse.json({ product: saved ? toPublicProduct(saved) : null });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json(
      { error: error instanceof Error ? error.message : "更新商品失败" },
      { status: 500 },
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const user = await requireUser(req);
    const body = await req.json().catch(() => ({}));
    const id = validId(body.id);
    if (!id) return NextResponse.json({ error: "商品 ID 无效" }, { status: 400 });
    const existing = await readOwnedProduct(user.id, id);
    if (!existing) return NextResponse.json({ error: "商品不存在或无权访问" }, { status: 404 });
    await getDb().delete(products).where(and(eq(products.id, id), eq(products.ownerId, user.id)));
    return NextResponse.json({ success: true });
  } catch (error) {
    return handleAuthRouteError(error) ?? NextResponse.json({ error: "删除商品失败" }, { status: 500 });
  }
}
