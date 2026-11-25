/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const runtime = path.resolve(process.env.LUMA_RUNTIME_ROOT || path.join(__dirname, "../.runtime"));
const base = path.join(runtime, "tools", "python");
if (!fs.existsSync(path.join(base, "python.exe"))) throw new Error("Bundled Python is missing");
for (const relative of ["asr/python", "quick-cut/runtime/fashion-vision/python", "quick-cut/runtime/metadata-watermark/python"]) {
  const venv = path.join(runtime, relative);
  if (!fs.existsSync(path.join(venv, "Scripts/python.exe"))) throw new Error(`Missing Python environment: ${relative}`);
  fs.writeFileSync(path.join(venv, "pyvenv.cfg"), `home = ${base}\ninclude-system-site-packages = false\nversion = 3.12.14\nexecutable = ${path.join(base, "python.exe")}\n`, "utf8");
}
console.log("Configured 3 bundled Python environments");
