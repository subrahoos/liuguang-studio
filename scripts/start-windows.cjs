/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname,"..");
const config = JSON.parse(fs.readFileSync(path.join(root,".local/config.json"),"utf8").replace(/^\uFEFF/,""));
const key = fs.readFileSync(path.join(config.dataRoot,"system/model-credential-encryption.key"),"utf8").trim();
if (Buffer.from(key,"base64").length !== 32) throw new Error("Invalid local credential key");
const env = {...process.env,LUMA_DATA_ROOT:config.dataRoot,LUMA_RUNTIME_ROOT:config.runtimeRoot,LUMA_CREDENTIAL_ENCRYPTION_KEY:key,LUMA_SECURE_COOKIES:config.secureCookies?"1":"0",PYTHONUTF8:"1",NEXT_TELEMETRY_DISABLED:"1"};
if(config.proxyUrl) Object.assign(env,{HTTP_PROXY:config.proxyUrl,HTTPS_PROXY:config.proxyUrl,NODE_USE_ENV_PROXY:"1",NO_PROXY:"localhost,127.0.0.1,::1"});
console.log(`流光商影: http://127.0.0.1:${config.port || 3100}`);
console.log(`本机数据: ${config.dataRoot}`);
const result=spawnSync(process.execPath,[path.join(root,"node_modules/next/dist/bin/next"),"start","-H","127.0.0.1","-p",String(config.port||3100)],{cwd:root,env,stdio:"inherit"});
if(result.error) console.error(result.error.message);
process.exitCode=result.status ?? 1;
