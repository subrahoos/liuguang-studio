/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const runtime = path.resolve(process.env.LUMA_RUNTIME_ROOT || path.join(__dirname, "../.runtime"));
const run = (exe,args) => execFileSync(exe,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"],timeout:240000,env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8",PYTHONDONTWRITEBYTECODE:"1"}});
async function sha(file) {
  const hash = crypto.createHash("sha256");
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest("hex");
}
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This release requires Windows x64");
  const inventory = JSON.parse(fs.readFileSync(path.join(__dirname,"../deployment/runtime-inventory.json"),"utf8"));
  for(const [index,file] of inventory.files.entries()) {
    const full = path.join(runtime,file.path);
    if(!fs.existsSync(full) || (!file.path.endsWith("pyvenv.cfg") && fs.statSync(full).size !== file.size)) throw new Error(`Runtime file missing or wrong size: ${file.path}`);
    if (!file.path.endsWith("pyvenv.cfg") && await sha(full) !== file.sha256) throw new Error(`Runtime SHA256 mismatch: ${file.path}`);
    if(index % 10000 === 0) console.log(`Runtime integrity: ${index}/${inventory.files.length}`);
  }
  console.log(`Runtime integrity: ${inventory.files.length}/${inventory.files.length}`);
  const Database=require("better-sqlite3");new Database(":memory:").close();
  run(path.join(runtime,"tools/ffmpeg/ffmpeg.exe"),["-version"]);
  run(path.join(runtime,"tools/ffmpeg/ffprobe.exe"),["-version"]);
  const ort=require(path.join(runtime,"quick-cut/runtime/node_modules/onnxruntime-node"));
  for(const model of ["face_detection_yunet_2023mar.onnx","person_detection_mediapipe_2023mar.onnx"]) {
    const session=await ort.InferenceSession.create(path.join(runtime,"quick-cut/runtime/face",model));await session.release();
  }
  run(path.join(runtime,"quick-cut/runtime/metadata-watermark/python/Scripts/python.exe"),["-c","import numpy; import ssl; print('metadata Python ready')"]);
  const vision = path.join(runtime,"quick-cut/runtime/fashion-vision");
  run(path.join(vision,"python/Scripts/python.exe"),["-c",`import sys;sys.path.insert(0,${JSON.stringify(path.join(vision,"rtmpose-packages"))});import cv2, torch, transformers, onnxruntime, rtmlib;print('vision Python ready')`]);
  run(path.join(vision,"python/Scripts/python.exe"),[path.join(__dirname,"verify-local-models.py"),"--runtime",runtime]);
  run(path.join(runtime,"asr/python/Scripts/python.exe"),["-c",`from faster_whisper import WhisperModel;WhisperModel(${JSON.stringify(path.join(runtime,"asr/models/small"))},device='cpu',compute_type='int8',local_files_only=True);print('ASR small model loaded')`]);
  console.log("PASS: SQLite, FFmpeg, face/person ONNX, Python vision, ASR weights");
}
main().catch(error => { console.error(error.message);process.exitCode=1; });
