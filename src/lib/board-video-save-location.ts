import type { BoardWorkflowNode } from "@/lib/board-workflows";

type DirectoryPermissionState = "granted" | "denied" | "prompt";
type WritableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryPermissionState>;
  requestPermission: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryPermissionState>;
};
type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<WritableDirectoryHandle>;
};

type StoredBoardVideoSaveLocation = {
  workflowId: string;
  directoryHandle: WritableDirectoryHandle;
  selectedAt?: string;
};

export type BoardVideoSaveLocation = {
  workflowId: string;
  directoryName: string;
  directoryHandle: WritableDirectoryHandle;
  /** Only outputs created after this selection are automatically copied. */
  selectedAt: string;
};

export type BoardVideoSaveResult = {
  fileName: string;
  bytesWritten: number;
};

const DATABASE_NAME = "luma-board-video-save-locations";
const DATABASE_VERSION = 1;
const STORE_NAME = "locations";

function browserDatabase() {
  if (typeof window === "undefined" || !window.indexedDB) {
    throw new Error("当前浏览器无法保存本地文件夹授权。");
  }
  return window.indexedDB;
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("浏览器本地保存设置失败。"));
  });
}

function transactionComplete(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("浏览器本地保存设置失败。"));
    transaction.onabort = () => reject(transaction.error || new Error("浏览器本地保存设置已取消。"));
  });
}

async function openLocationDatabase() {
  const request = browserDatabase().open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: "workflowId" });
    }
  };
  return requestResult(request);
}

async function withLocationStore<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>) {
  const database = await openLocationDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const result = await requestResult(operation(transaction.objectStore(STORE_NAME)));
    await transactionComplete(transaction);
    return result;
  } finally {
    database.close();
  }
}

function toLocation(record: StoredBoardVideoSaveLocation | undefined): BoardVideoSaveLocation | null {
  if (!record?.directoryHandle) return null;
  return {
    workflowId: record.workflowId,
    directoryName: record.directoryHandle.name || "已选文件夹",
    directoryHandle: record.directoryHandle,
    selectedAt: record.selectedAt || "",
  };
}

export async function loadBoardVideoSaveLocation(workflowId: string) {
  const record = await withLocationStore("readonly", (store) => store.get(workflowId));
  return toLocation(record as StoredBoardVideoSaveLocation | undefined);
}

export async function chooseBoardVideoSaveLocation(workflowId: string) {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("当前浏览器不支持本地文件夹选择，请使用 Chrome 或 Edge。");
  const directoryHandle = await picker({ mode: "readwrite" });
  const selectedAt = new Date().toISOString();
  const record = { workflowId, directoryHandle, selectedAt } satisfies StoredBoardVideoSaveLocation;
  await withLocationStore("readwrite", (store) => store.put(record));
  return toLocation(record)!;
}

export async function clearBoardVideoSaveLocation(workflowId: string) {
  await withLocationStore("readwrite", (store) => store.delete(workflowId));
}

export async function ensureBoardVideoSaveLocationPermission(
  location: BoardVideoSaveLocation,
  requestPermission = false,
) {
  const options = { mode: "readwrite" as const };
  let permission = await location.directoryHandle.queryPermission(options);
  if (permission !== "granted" && requestPermission) {
    permission = await location.directoryHandle.requestPermission(options);
  }
  if (permission !== "granted") {
    throw new Error(`文件夹“${location.directoryName}”尚未授予写入权限，请重新选择或点击同步已有视频后授权。`);
  }
}

export function isBoardVideoSaveCandidate(node: BoardWorkflowNode) {
  const role = String(node.meta?.assetRole || "");
  return node.kind === "video_clip"
    && (role === "generated_video" || role === "composed_video")
    && Boolean(node.filePath && node.publicUrl);
}

export function wasBoardVideoCreatedAfterSaveLocationSelection(
  node: Pick<BoardWorkflowNode, "createdAt">,
  selectedAt: string,
) {
  const createdAt = Date.parse(node.createdAt);
  const selectionTimestamp = Date.parse(selectedAt);
  return Number.isFinite(selectionTimestamp)
    && Number.isFinite(createdAt)
    && createdAt >= selectionTimestamp;
}

export function boardVideoSaveFileName(node: Pick<BoardWorkflowNode, "filePath" | "id">) {
  const sourceName = String(node.filePath || "").split(/[\\/]/).pop() || "";
  const sanitized = sourceName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/[. ]+$/g, "")
    .trim();
  return sanitized && /\.mp4$/i.test(sanitized) ? sanitized : `画板视频-${node.id}.mp4`;
}

export async function saveBoardVideoToLocation(
  location: BoardVideoSaveLocation,
  node: Pick<BoardWorkflowNode, "filePath" | "id" | "publicUrl">,
) {
  if (!node.publicUrl) throw new Error("画板视频缺少可下载地址，无法同步到所选文件夹。");
  const response = await fetch(node.publicUrl, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok || !response.body) {
    throw new Error(`画板视频下载失败（HTTP ${response.status}），未写入所选文件夹。`);
  }

  const expectedBytes = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    throw new Error("画板视频响应缺少可信文件长度，未写入所选文件夹。");
  }
  const fileName = boardVideoSaveFileName(node);
  const fileHandle = await location.directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable({ keepExistingData: false });
  const reader = response.body.getReader();
  let bytesWritten = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      bytesWritten += value.byteLength;
      await writable.write(value);
    }
    if (bytesWritten !== expectedBytes) {
      throw new Error(`画板视频下载不完整（${bytesWritten}/${expectedBytes} 字节），未写入所选文件夹。`);
    }
    await writable.close();
  } catch (error) {
    await writable.abort(error).catch(() => undefined);
    throw error;
  }
  return { fileName, bytesWritten } satisfies BoardVideoSaveResult;
}
