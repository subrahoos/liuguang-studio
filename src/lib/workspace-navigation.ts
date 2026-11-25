export const WORKSPACE_FEATURES = [
  { id: "overview", title: "流光创作引擎", desc: "创作指挥中心" },
  { id: "new", title: "新建视频项目", desc: "开启全新链路" },
  { id: "clone", title: "爆款复刻", desc: "拆解参考逻辑" },
  { id: "board", title: "画板工作流", desc: "节点式推进" },
  { id: "product-production", title: "商品生产线", desc: "视频与详情图批量生产" },
  { id: "quick-cut", title: "流光快剪", desc: "本机批量电商混剪" },
  { id: "products", title: "商品库", desc: "素材资产管理" },
  { id: "methods", title: "方法库", desc: "镜头语言沉淀" },
  { id: "identity", title: "人物身份包", desc: "视觉一致性" },
  { id: "analytics", title: "经营诊断", desc: "利润与经营复盘" },
] as const;

export type WorkspaceModuleId = (typeof WORKSPACE_FEATURES)[number]["id"];
export type WorkspaceFeatureEntryState = "open" | "waiting";
export type WorkspaceFeatureEntries = Record<WorkspaceModuleId, WorkspaceFeatureEntryState>;

export const WORKSPACE_FEATURE_IDS = WORKSPACE_FEATURES.map((feature) => feature.id) as WorkspaceModuleId[];

export function isWorkspaceModuleId(value: string): value is WorkspaceModuleId {
  return WORKSPACE_FEATURE_IDS.includes(value as WorkspaceModuleId);
}

export function resolveWorkspaceFeatureEntries(
  overrides: Partial<Record<WorkspaceModuleId, WorkspaceFeatureEntryState>> = {},
): WorkspaceFeatureEntries {
  return Object.fromEntries(
    WORKSPACE_FEATURE_IDS.map((featureId) => [featureId, overrides[featureId] === "waiting" ? "waiting" : "open"]),
  ) as WorkspaceFeatureEntries;
}

export function workspaceModuleHref(module: WorkspaceModuleId, entityId?: string) {
  const params = new URLSearchParams({ module });
  if (module === "board" && entityId?.trim()) params.set("boardId", entityId.trim());
  if (module === "product-production" && entityId?.trim()) params.set("productionId", entityId.trim());
  if (module === "quick-cut" && entityId?.trim()) params.set("taskId", entityId.trim());
  return `/workspace?${params.toString()}`;
}

export const WORKSPACE_NAVIGATION = WORKSPACE_FEATURES.map((feature) => ({
  href: workspaceModuleHref(feature.id),
  title: feature.title,
  desc: feature.desc,
}));
