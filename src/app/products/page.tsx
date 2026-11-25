"use client";

import { useCallback, useRef, useState } from "react";
import Link from "next/link";
import { LuArrowLeft, LuImage, LuPackage, LuPencil, LuPlus, LuTrash2, LuX } from "react-icons/lu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceEmbed } from "@/components/workspace-embed-context";
import {
  DEFAULT_PRODUCT_STRUCTURE_LOCK_RULE,
  useProductLibraryStore,
  type ProductItem,
} from "@/lib/stores/product-library-store";

const categoryOptions = [
  { value: "beauty", label: "美妆护肤" },
  { value: "food", label: "食品零食" },
  { value: "home", label: "家居日用" },
  { value: "fashion", label: "服饰鞋包" },
  { value: "tech", label: "数码3C" },
  { value: "other", label: "其他" },
] as const;

const categoryColorMap: Record<string, string> = {
  beauty: "bg-pink-500/20 text-pink-400",
  food: "bg-amber-500/20 text-amber-400",
  home: "bg-blue-500/20 text-blue-400",
  fashion: "bg-purple-500/20 text-purple-400",
  tech: "bg-cyan-500/20 text-cyan-400",
  other: "bg-zinc-500/20 text-zinc-400",
};

const categoryLabelMap: Record<string, string> = Object.fromEntries(
  categoryOptions.map((option) => [option.value, option.label])
);

type DraftImage = {
  id: string;
  url: string;
  file?: File;
};

function ProductsWorkspace({
  embedded = false,
}: {
  embedded?: boolean;
} = {}) {
  const { products, addProduct, updateProduct, removeProduct } = useProductLibraryStore();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<ProductItem["category"]>("other");
  const [description, setDescription] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [usageScenarios, setUsageScenarios] = useState("");
  const [negativeConstraints, setNegativeConstraints] = useState("");
  const [images, setImages] = useState<DraftImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [productError, setProductError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resetForm = () => {
    setName("");
    setCategory("other");
    setDescription("");
    setTargetAudience("");
    setUsageScenarios("");
    setNegativeConstraints("");
    setImages([]);
    setEditingId(null);
    setIsFormOpen(false);
    setProductError("");
  };

  const handleFiles = useCallback(
    (files: FileList | null) => {
      if (!files) return;
      const remaining = 5 - images.length;
      if (remaining <= 0) return;

      const nextImages = Array.from(files)
        .slice(0, remaining)
        .filter((file) => file.type.startsWith("image/"))
        .map((file) => ({
          id: crypto.randomUUID(),
          url: URL.createObjectURL(file),
          file,
        }));

      setImages((current) => [...current, ...nextImages]);
    },
    [images.length]
  );

  const removeImage = useCallback((id: string) => {
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target?.file) URL.revokeObjectURL(target.url);
      return current.filter((image) => image.id !== id);
    });
  }, []);

  const startEdit = (product: ProductItem) => {
    setEditingId(product.id);
    setName(product.name);
    setCategory(product.category);
    setDescription(product.description || "");
    setTargetAudience(product.targetAudience || "");
    setUsageScenarios(product.usageScenarios || "");
    setNegativeConstraints(product.negativeConstraints || "");
    setImages(product.images.map((url) => ({ id: crypto.randomUUID(), url })));
    setProductError("");
    setIsFormOpen(true);
  };

  const persistProductImages = async () => {
    const fileImages = images.filter((image) => image.file);
    if (fileImages.length === 0) return images.map((image) => image.url);

    const formData = new FormData();
    fileImages.forEach((image) => {
      if (image.file) formData.append("files", image.file);
    });
    formData.append("projectId", "product-library");

    const response = await fetch("/api/upload", { method: "POST", body: formData });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || "商品图片上传失败");

    const uploadedPaths = result.paths as string[] | undefined;
    if (!uploadedPaths || uploadedPaths.length !== fileImages.length) {
      throw new Error("商品图片上传结果数量异常");
    }

    let uploadIndex = 0;
    return images.map((image) => {
      if (!image.file) return image.url;
      const path = uploadedPaths[uploadIndex];
      uploadIndex += 1;
      return path;
    });
  };

  const handleSave = async () => {
    if (!name.trim() || images.length === 0 || isSavingProduct) return;
    setIsSavingProduct(true);
    setProductError("");

    try {
      const imageUrls = await persistProductImages();
      const productFields = {
        name: name.trim(),
        category,
        description: description.trim() || undefined,
        images: imageUrls,
        price: undefined,
        targetAudience: targetAudience.trim() || undefined,
        structureLock: undefined,
        usageScenarios: usageScenarios.trim() || undefined,
        negativeConstraints: negativeConstraints.trim() || undefined,
      };

      if (editingId) {
        const saveResponse = await fetch("/api/products", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: editingId, product: productFields }),
        });
        const saveResult = await saveResponse.json().catch(() => ({}));
        if (!saveResponse.ok || !saveResult.product) {
          throw new Error(saveResult.error || "商品保存失败");
        }
        updateProduct(editingId, {
          ...saveResult.product,
          createdAt: new Date(saveResult.product.createdAt),
        });
        const syncResponse = await fetch("/api/project/sync-product", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            productId: editingId,
            productName: productFields.name,
          }),
        });
        const syncResult = await syncResponse.json().catch(() => ({}));
        if (!syncResponse.ok) {
          throw new Error(syncResult.error || "商品已保存，但同步到我的项目失败");
        }
      } else {
        const saveResponse = await fetch("/api/products", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            product: {
              id: crypto.randomUUID(),
              ...productFields,
              videoCount: 0,
              createdAt: new Date().toISOString(),
            },
          }),
        });
        const saveResult = await saveResponse.json().catch(() => ({}));
        if (!saveResponse.ok || !saveResult.product) {
          throw new Error(saveResult.error || "商品保存失败");
        }
        addProduct({
          ...saveResult.product,
          createdAt: new Date(saveResult.product.createdAt),
        });
      }

      resetForm();
    } catch (error) {
      setProductError(error instanceof Error ? error.message : "商品保存失败");
    } finally {
      setIsSavingProduct(false);
    }
  };

  const handleDelete = async (id: string) => {
    setProductError("");
    try {
      const response = await fetch("/api/products", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "删除商品失败");
      removeProduct(id);
      if (editingId === id) resetForm();
    } catch (error) {
      setProductError(error instanceof Error ? error.message : "删除商品失败");
    }
  };

  const canSave = Boolean(name.trim() && images.length > 0 && !isSavingProduct);

  return (
    <div className="min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg brand-gradient text-sm font-bold text-white">
              AI
            </div>
            <span className="text-lg font-bold tracking-tight">商品库</span>
          </div>
          {embedded ? (
            <Button type="button" variant="ghost" size="sm" className="hidden">
              <LuArrowLeft className="h-4 w-4" />
              <span className="ml-1.5">返回工作台</span>
            </Button>
          ) : (
            <Link href="/workspace?module=products">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                <LuArrowLeft className="h-4 w-4" />
                <span className="ml-1.5">返回首页</span>
              </Button>
            </Link>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              <span className="brand-gradient-text">商品库</span>管理
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              这里只维护产品包基础资产。产品结构锁会在生成脚本时由 LLM 根据商品图自动反推。
            </p>
          </div>
          {!isFormOpen && (
            <Button
              className="brand-gradient text-white"
              onClick={() => {
                resetForm();
                setIsFormOpen(true);
              }}
            >
              <LuPlus className="mr-1.5 h-4 w-4" />
              添加商品
            </Button>
          )}
        </div>

        {isFormOpen && (
          <Card className="glass-card mb-8 ring-1 ring-primary/30">
            <CardContent className="space-y-5 p-5">
              <h3 className="text-sm font-semibold">{editingId ? "编辑商品" : "添加商品"}</h3>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="productName" className="text-sm font-medium">
                    商品名称 <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="productName"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如：浅蓝短款翻领衬衫套装"
                    className="border-border/50 bg-muted/30 focus:border-primary"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">商品品类</Label>
                  <Select
                    value={category}
                    onValueChange={(value) => setCategory((value ?? "other") as ProductItem["category"])}
                  >
                    <SelectTrigger className="border-border/50 bg-muted/30">
                      <SelectValue placeholder="选择商品品类" />
                    </SelectTrigger>
                    <SelectContent>
                      {categoryOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="description" className="text-sm font-medium">卖点补充</Label>
                  <span className="text-xs text-muted-foreground">可不填</span>
                </div>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="可不填。系统会根据商品图自动提炼卖点；如果有必须强调的点，可以写在这里。"
                  rows={3}
                  className="resize-none border-border/50 bg-muted/30 focus:border-primary"
                />
              </div>

              <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-xs leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">默认产品锁规则</p>
                <p className="mt-1 whitespace-pre-line">{DEFAULT_PRODUCT_STRUCTURE_LOCK_RULE}</p>
                <p className="mt-2 text-primary">
                  你不用在商品库手写结构锁；生成普通项目或爆款复刻脚本时，LLM 会根据商品图自动反推具体结构锁。
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="usageScenarios" className="text-sm font-medium">展示场景/使用方式</Label>
                    <span className="text-xs text-muted-foreground">可不填</span>
                  </div>
                  <Textarea
                    id="usageScenarios"
                    value={usageScenarios}
                    onChange={(event) => setUsageScenarios(event.target.value)}
                    placeholder="可不填。系统会根据商品图和品类自动判断；如有指定场景，例如通勤、约会、居家对镜、车内、街拍，可写在这里。"
                    rows={3}
                    className="resize-none border-border/50 bg-muted/30 focus:border-primary"
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="negativeConstraints" className="text-sm font-medium">额外禁止项</Label>
                    <span className="text-xs text-muted-foreground">可不填</span>
                  </div>
                  <Textarea
                    id="negativeConstraints"
                    value={negativeConstraints}
                    onChange={(event) => setNegativeConstraints(event.target.value)}
                    placeholder="可不填。默认产品锁已禁止变色、改款、错品类、文字水印和价格牌；如有额外限制可写在这里。"
                    rows={3}
                    className="resize-none border-border/50 bg-muted/30 focus:border-primary"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="targetAudience" className="text-sm font-medium">目标人群补充</Label>
                  <span className="text-xs text-muted-foreground">可不填</span>
                </div>
                <Input
                  id="targetAudience"
                  value={targetAudience}
                  onChange={(event) => setTargetAudience(event.target.value)}
                  placeholder="可不填。系统会根据商品图和品类自动判断；如有明确人群可写在这里。"
                  className="border-border/50 bg-muted/30 focus:border-primary"
                />
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between">
                  <Label className="text-sm font-medium">
                    商品图片 <span className="text-destructive">*</span>
                  </Label>
                  <span className="text-xs text-muted-foreground">{images.length}/5 张</span>
                </div>

                {images.length < 5 && (
                  <div
                    className={`relative cursor-pointer rounded-xl border-2 border-dashed p-8 text-center transition-all ${
                      isDragging
                        ? "border-primary bg-primary/5"
                        : "border-border/60 hover:border-primary/50 hover:bg-muted/20"
                    }`}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setIsDragging(true);
                    }}
                    onDragLeave={(event) => {
                      event.preventDefault();
                      setIsDragging(false);
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      setIsDragging(false);
                      handleFiles(event.dataTransfer.files);
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(event) => {
                        handleFiles(event.target.files);
                        event.target.value = "";
                      }}
                    />
                    <div className="flex flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50">
                        <LuImage className="h-6 w-6 text-muted-foreground" />
                      </div>
                      <div>
                        <p className="text-sm font-medium">
                          拖拽图片到这里，或 <span className="brand-gradient-text font-semibold">点击上传</span>
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          支持 JPG / PNG / WebP，最多 5 张。建议放商品正面、侧面、背面、细节、上身或使用图。
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {images.length > 0 && (
                  <div className={`grid grid-cols-3 gap-3 sm:grid-cols-5 ${images.length < 5 ? "mt-4" : ""}`}>
                    {images.map((image) => (
                      <div
                        key={image.id}
                        className="group relative aspect-square overflow-hidden rounded-lg border border-border/50 bg-muted/20"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.url} alt="商品图片" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeImage(image.id)}
                          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-500 group-hover:opacity-100"
                        >
                          <LuX className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {productError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {productError}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <Button variant="outline" size="sm" onClick={resetForm} disabled={isSavingProduct}>
                  取消
                </Button>
                <Button
                  size="sm"
                  className="brand-gradient text-white"
                  onClick={() => void handleSave()}
                  disabled={!canSave}
                >
                  {isSavingProduct ? "保存中..." : editingId ? "保存修改" : "添加商品"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {products.length === 0 && !isFormOpen ? (
          <Card className="glass-card">
            <CardContent className="flex flex-col items-center justify-center py-16 text-center">
              <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted/50">
                <LuPackage className="h-7 w-7 text-muted-foreground" />
              </div>
              <p className="mb-4 text-muted-foreground">还没有商品，添加你的第一个商品</p>
              <Button
                className="brand-gradient text-white"
                onClick={() => {
                  resetForm();
                  setIsFormOpen(true);
                }}
              >
                <LuPlus className="mr-1.5 h-4 w-4" />
                添加商品
              </Button>
            </CardContent>
          </Card>
        ) : (
          products.length > 0 && (
            <div>
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-lg font-semibold">全部商品</h2>
                <span className="text-sm text-muted-foreground">{products.length} 个商品</span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {products.map((product) => (
                  <Card key={product.id} className="card-hover glass-card group">
                    <CardContent className="p-0">
                      <div className="relative aspect-video overflow-hidden rounded-t-lg bg-muted/30">
                        {product.images.length > 0 ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={product.images[0]} alt={product.name} className="h-full w-full object-cover" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <LuImage className="h-8 w-8 text-muted-foreground/50" />
                          </div>
                        )}
                        <div className="absolute left-2 top-2">
                          <Badge className={`${categoryColorMap[product.category] || categoryColorMap.other} border-0 text-xs`}>
                            {categoryLabelMap[product.category] || "其他"}
                          </Badge>
                        </div>
                        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                          <button
                            type="button"
                            onClick={() => startEdit(product)}
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-primary"
                          >
                            <LuPencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(product.id)}
                            className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white transition-colors hover:bg-red-500"
                          >
                            <LuTrash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="p-4">
                        <h3 className="truncate text-sm font-medium transition-colors group-hover:text-primary">
                          {product.name}
                        </h3>
                        <div className="mt-2 flex items-center justify-between">
                          <span className="text-xs text-muted-foreground">{product.videoCount} 个视频</span>
                          <span className="text-xs text-primary">{product.images.length} 张图</span>
                        </div>
                        <div className="mt-3 rounded-md border border-primary/10 bg-primary/5 p-2 text-[11px] leading-relaxed text-muted-foreground">
                          默认产品锁：生成时由 LLM 根据商品图自动反推
                        </div>
                        {(product.usageScenarios || product.negativeConstraints || product.targetAudience) && (
                          <div className="mt-3 space-y-1 text-[11px] leading-relaxed text-muted-foreground">
                            {product.targetAudience && <p className="line-clamp-1">人群：{product.targetAudience}</p>}
                            {product.usageScenarios && <p className="line-clamp-1">场景：{product.usageScenarios}</p>}
                            {product.negativeConstraints && <p className="line-clamp-1">限制：{product.negativeConstraints}</p>}
                          </div>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )
        )}
      </main>
    </div>
  );
}

export default function ProductsPage() {
  const { embedded } = useWorkspaceEmbed();
  return <ProductsWorkspace embedded={embedded} />;
}
