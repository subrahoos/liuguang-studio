import path from "path";

export function isPathWithin(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function assertExternalQuickCutOutputFolder(taskRoot: string, outputFolder: string) {
  if (isPathWithin(taskRoot, outputFolder)) {
    throw new Error("输出位置不能选择流光快剪内部任务目录，请选择任务目录之外的文件夹");
  }
}
