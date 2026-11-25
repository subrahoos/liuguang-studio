const { spawn } = require("node:child_process");

function runProcess(command, args, {
  cwd,
  signal,
  onStdout,
  onStderr,
  encoding = "utf8",
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      signal,
      shell: false,
      windowsHide: true,
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    if (encoding) {
      child.stdout.setEncoding(encoding);
      child.stderr.setEncoding(encoding);
    }
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      onStderr?.(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const join = (chunks) => encoding
        ? chunks.join("")
        : Buffer.concat(chunks.map((chunk) =>
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      const stdout = join(stdoutChunks);
      const stderr = join(stderrChunks);
      const result = { code, stdout, stderr };
      if (code === 0) {
        resolve(result);
        return;
      }
      const stderrText = Buffer.isBuffer(stderr)
        ? stderr.toString("utf8")
        : stderr;
      const error = new Error(
        stderrText.trim() || `进程退出，代码 ${code}`,
      );
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

module.exports = { runProcess };

