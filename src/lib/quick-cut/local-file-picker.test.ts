import { spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localPickerWorkerScript, localVideoFilePickerCompileScript, localVideoFilePickerSource } from "@/lib/quick-cut/local-file-picker";
import { modernFolderPickerSource } from "@/lib/quick-cut/modern-folder-picker";
import { windowsPickerDpiSource } from "@/lib/quick-cut/windows-picker-dpi";

describe("流光快剪本地视频选择器", () => {
  it("在编译 WinForms 选择器源码前加载对应程序集", () => {
    const script = localVideoFilePickerCompileScript(Buffer.from(localVideoFilePickerSource, "utf8").toString("base64"));

    expect(localVideoFilePickerSource).toContain("using System.Windows.Forms;");
    expect(script[0]).toBe("Add-Type -AssemblyName System.Windows.Forms");
    expect(script[1]).toBe("$formsAssembly = [System.Windows.Forms.OpenFileDialog].Assembly.Location");
    expect(script[3]).toBe("Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies $formsAssembly");
  });

  it("通过 PowerShell 的 STA 进程真正启动 Windows 选择窗口，并以 UTF-8 Base64 回传路径", async () => {
    const moduleSource = await import("@/lib/quick-cut/local-file-picker");
    expect(moduleSource.pickLocalVideoFiles).toBeTypeOf("function");
    expect(localVideoFilePickerSource).toContain("dialog.Multiselect = true;");
    expect(moduleSource.localVideoFilePickerCompileScript("source").join(";")).toContain("-ReferencedAssemblies $formsAssembly");
  });
});

describe("Windows 鏂囦欢閫夋嫨 worker", () => {
  it("澶嶇敤 worker 銆佽繑鍥炴暟缁勫苟鍦ㄦ墦寮€绐楀彛鍓嶅惎鐢ㄥ睆骞曠缉鏀", () => {
    const script = localPickerWorkerScript({
      dpiSource: windowsPickerDpiSource,
      videoSource: localVideoFilePickerSource,
      folderSource: modernFolderPickerSource,
    });

    expect(windowsPickerDpiSource).toContain("SetProcessDpiAwarenessContext");
    expect(script).toContain(Buffer.from(windowsPickerDpiSource, "utf8").toString("base64"));
    expect(script).toContain("[LumaWindowsPickerDpi]::Enable()");
    expect(script).toContain("Add-Type -AssemblyName System.Windows.Forms");
    expect(script).toContain("while ($line = [Console]::In.ReadLine())");
    expect(script).toContain("ConvertTo-Json -InputObject");
    expect(script).toContain("[string[]]$selectedPaths.ToArray()");
    expect(script).toContain("$kind -eq 'folder'");
    expect(script).toContain("[Console]::Out.WriteLine('READY')");
  });

  it("启动 PowerShell worker 并完成不弹窗的协议握手", async () => {
    if (process.platform !== "win32") return;
    const script = localPickerWorkerScript({
      dpiSource: windowsPickerDpiSource,
      videoSource: localVideoFilePickerSource,
      folderSource: modernFolderPickerSource,
    });
    const child = spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let output = "";
    const nextLine = () => new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker handshake timed out: ${output}`)), 30_000);
      const onData = (chunk: string) => {
        output += chunk;
        const index = output.indexOf("\n");
        if (index < 0) return;
        clearTimeout(timer);
        child.stdout.off("data", onData);
        const line = output.slice(0, index).replace(/\r$/, "");
        output = output.slice(index + 1);
        resolve(line);
      };
      child.stdout.on("data", onData);
      child.once("error", reject);
    });

    try {
      await expect(nextLine()).resolves.toBe("READY");
      child.stdin.write("invalid|aW52YWxpZA==\n", "utf8");
      await expect(nextLine()).resolves.toMatch(/^ERR\\|/);
    } finally {
      child.kill();
    }
  }, 45_000);
});
