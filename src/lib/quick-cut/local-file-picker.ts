import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { modernFolderPickerSource } from "@/lib/quick-cut/modern-folder-picker";
import { windowsPickerDpiSource } from "@/lib/quick-cut/windows-picker-dpi";

let pickerWorker: ChildProcessWithoutNullStreams | null = null;
let pickerWorkerOutput = "";
const pickerWorkerLines: string[] = [];
const pickerWorkerWaiters: Array<{
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}> = [];
let pickerWorkerStart: Promise<ChildProcessWithoutNullStreams> | null = null;
let pickerQueue: Promise<string[]> = Promise.resolve([]);

export const localVideoFilePickerSource = `
using System;
using System.Windows.Forms;

public static class LumaQuickCutVideoPicker
{
    public static string[] Pick(string initialDirectory, string title)
    {
        using (var dialog = new OpenFileDialog())
        {
            dialog.Title = title;
            dialog.Multiselect = true;
            dialog.CheckFileExists = true;
            dialog.CheckPathExists = true;
            dialog.Filter = "\u89c6\u9891\u6587\u4ef6|*.mp4;*.mov;*.mkv;*.avi;*.webm;*.m4v|\u6240\u6709\u6587\u4ef6|*.*";
            if (!String.IsNullOrWhiteSpace(initialDirectory) && System.IO.Directory.Exists(initialDirectory))
            {
                dialog.InitialDirectory = initialDirectory;
            }
            return dialog.ShowDialog() == DialogResult.OK ? dialog.FileNames : new string[0];
        }
    }
}
`;

export function localVideoFilePickerCompileScript(encodedSource: string) {
  return [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$formsAssembly = [System.Windows.Forms.OpenFileDialog].Assembly.Location",
    `$source = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSource}'))`,
    "Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies $formsAssembly",
  ];
}

export function localFolderPickerCompileScript(encodedSource: string) {
  return [
    `$source = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedSource}'))`,
    "Add-Type -TypeDefinition $source -Language CSharp",
  ];
}

export function localPickerWorkerScript({
  dpiSource,
  videoSource,
  folderSource,
}: {
  dpiSource: string;
  videoSource: string;
  folderSource: string;
}) {
  const encodedDpi = Buffer.from(dpiSource, "utf8").toString("base64");
  const encodedVideo = Buffer.from(videoSource, "utf8").toString("base64");
  const encodedFolder = Buffer.from(folderSource, "utf8").toString("base64");

  return [
    "$ErrorActionPreference = 'Stop'",
    `$dpiSource = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedDpi}'))`,
    `$videoSource = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedVideo}'))`,
    `$folderSource = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedFolder}'))`,
    "Add-Type -TypeDefinition $dpiSource -Language CSharp",
    "[LumaWindowsPickerDpi]::Enable()",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$formsAssembly = [System.Windows.Forms.OpenFileDialog].Assembly.Location",
    "Add-Type -TypeDefinition $videoSource -Language CSharp -ReferencedAssemblies $formsAssembly",
    "Add-Type -TypeDefinition $folderSource -Language CSharp",
    "[Console]::Out.WriteLine('READY')",
    "[Console]::Out.Flush()",
    "while ($line = [Console]::In.ReadLine()) {",
    "  if ([string]::IsNullOrWhiteSpace($line)) { continue }",
    "  try {",
    "    $parts = $line -split '\\|', 2",
    "    if ($parts.Count -lt 2) { throw 'Invalid picker request' }",
    "    $kind = $parts[0]",
    "    $title = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))",
    "    [LumaWindowsPickerDpi]::Enable()",
    "    $selectedPaths = [System.Collections.Generic.List[string]]::new()",
    "    if ($kind -eq 'video') {",
    "      foreach ($selectedPath in @([LumaQuickCutVideoPicker]::Pick('', $title))) { if (-not [string]::IsNullOrWhiteSpace([string]$selectedPath)) { [void]$selectedPaths.Add([string]$selectedPath) } }",
    "    } elseif ($kind -eq 'folder') {",
    "      $selectedPath = [ModernFolderPicker]::Pick('', $title)",
    "      if (-not [string]::IsNullOrWhiteSpace([string]$selectedPath)) { [void]$selectedPaths.Add([string]$selectedPath) }",
    "    } else {",
    "      throw 'Invalid picker kind'",
    "    }",
    "    $payload = if ($selectedPaths.Count -gt 0) { ConvertTo-Json -InputObject ([string[]]$selectedPaths.ToArray()) -Compress } else { '[]' }",
    "    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$payload))",
    "    [Console]::Out.WriteLine('OK|' + $encoded)",
    "  } catch {",
    "    $encoded = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))",
    "    [Console]::Out.WriteLine('ERR|' + $encoded)",
    "  }",
    "  [Console]::Out.Flush()",
    "}",
  ].join(";");
}

function powershellExecutable() {
  return path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function encodePickerValue(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function pickerWorkerScript() {
  return localPickerWorkerScript({
    dpiSource: windowsPickerDpiSource,
    videoSource: localVideoFilePickerSource,
    folderSource: modernFolderPickerSource,
  });
}

function consumePickerWorkerOutput(chunk: string) {
  pickerWorkerOutput += chunk;
  while (pickerWorkerOutput.includes("\n")) {
    const index = pickerWorkerOutput.indexOf("\n");
    const line = pickerWorkerOutput.slice(0, index).replace(/\r$/, "");
    pickerWorkerOutput = pickerWorkerOutput.slice(index + 1);
    const waiter = pickerWorkerWaiters.shift();
    if (waiter) waiter.resolve(line);
    else pickerWorkerLines.push(line);
  }
}

function readPickerWorkerLine() {
  const line = pickerWorkerLines.shift();
  if (line !== undefined) return Promise.resolve(line);
  return new Promise<string>((resolve, reject) => {
    pickerWorkerWaiters.push({ resolve, reject });
  });
}

function failPickerWorker(error: Error, child: ChildProcessWithoutNullStreams) {
  if (pickerWorker === child) {
    pickerWorker = null;
    pickerWorkerOutput = "";
    pickerWorkerLines.length = 0;
  }
  while (pickerWorkerWaiters.length) pickerWorkerWaiters.shift()?.reject(error);
}

async function ensurePickerWorker() {
  if (pickerWorker && !pickerWorker.killed && pickerWorker.exitCode === null) return pickerWorker;
  if (pickerWorkerStart) return pickerWorkerStart;

  pickerWorkerOutput = "";
  pickerWorkerLines.length = 0;
  pickerWorkerStart = new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
    const child = spawn(
      powershellExecutable(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", pickerWorkerScript()],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let startupOutput = "";
    let startupSettled = false;
    const startupTimer = setTimeout(() => {
      if (startupSettled) return;
      startupSettled = true;
      child.kill();
      reject(new Error(`Windows file picker initialization timed out${startupOutput ? `: ${startupOutput.trim()}` : ""}`));
    }, 15_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consumePickerWorkerOutput(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { startupOutput += chunk; });
    child.once("error", (error) => {
      clearTimeout(startupTimer);
      if (!startupSettled) {
        startupSettled = true;
        reject(new Error(`Windows file picker failed to start: ${error.message}`));
      }
      failPickerWorker(error, child);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(startupTimer);
      const error = new Error(`Windows file picker exited${code === null ? ` (${signal ?? "unknown signal"})` : ` (code ${code})`}`);
      if (!startupSettled) {
        startupSettled = true;
        reject(new Error(`Windows file picker initialization failed${startupOutput ? `: ${startupOutput.trim()}` : ""}`));
      }
      failPickerWorker(error, child);
    });
    pickerWorker = child;

    void readPickerWorkerLine().then((line) => {
      if (line !== "READY") {
        startupSettled = true;
        clearTimeout(startupTimer);
        child.kill();
        reject(new Error(`Windows file picker returned an invalid initialization response: ${line}`));
        return;
      }
      startupSettled = true;
      clearTimeout(startupTimer);
      resolve(child);
    }).catch((error: Error) => {
      if (startupSettled) return;
      startupSettled = true;
      clearTimeout(startupTimer);
      reject(error);
    });
  }).finally(() => { pickerWorkerStart = null; });
  return pickerWorkerStart;
}

export function warmLocalPickerWorker() {
  if (process.platform === "win32") void ensurePickerWorker().catch(() => undefined);
}

async function requestPicker(kind: "video" | "folder", title: string) {
  if (process.platform !== "win32") throw new Error("Local picker only supports Windows");
  const request = `${kind}|${encodePickerValue(title)}\n`;
  pickerQueue = pickerQueue.catch(() => undefined).then(async () => {
    const worker = await ensurePickerWorker();
    worker.stdin.write(request, "utf8");
    const response = await readPickerWorkerLine();
    const [status, payload = ""] = response.split("|", 2);
    const value = payload ? Buffer.from(payload, "base64").toString("utf8") : "";
    if (status === "ERR") throw new Error(value || "Windows file picker failed");
    if (status !== "OK") throw new Error("Windows file picker returned an invalid result");
    const parsed: unknown = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  });
  return pickerQueue;
}

export async function pickLocalVideoFiles({ title = "\u9009\u62e9\u9700\u8981\u5904\u7406\u7684\u672c\u5730\u89c6\u9891" } = {}) {
  const selected = await requestPicker("video", title);
  return selected.filter((filePath) => path.isAbsolute(filePath));
}

export async function pickLocalFolder({ title = "\u9009\u62e9\u6e05\u7406\u540e\u7684\u6587\u4ef6\u8f93\u51fa\u4f4d\u7f6e" } = {}) {
  const selected = await requestPicker("folder", title);
  const folder = selected[0];
  return folder && path.isAbsolute(folder) ? folder : null;
}

process.once("exit", () => {
  pickerWorker?.kill();
});
