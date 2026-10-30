import { mkdir, readFile, writeFile, rename, access } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {dataDirectory} from "./platform.mjs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendor = path.join(root, ".runtime/vendor");
const home = dataDirectory();
await mkdir(vendor, { recursive: true });
await mkdir(home, { recursive: true });
const lock = {};
async function download(url, dest, hash) {
  try {
    await access(dest);
    if (
      !hash ||
      createHash("sha256")
        .update(await readFile(dest))
        .digest("hex") === hash
    )
      return;
  } catch {}
  console.log(`Download: ${path.basename(dest)}`);
  await mkdir(path.dirname(dest), { recursive: true });
  const r = await fetch(url);
  if (!r.ok) throw Error(`${r.status}: ${url}`);
  await pipeline(Readable.fromWeb(r.body), createWriteStream(dest + ".part"));
  const actual = createHash("sha256")
    .update(await readFile(dest + ".part"))
    .digest("hex");
  if (hash && hash !== actual) throw Error(`Checksum mismatch: ${dest}`);
  await rename(dest + ".part", dest);
  lock[path.basename(dest)] = { url, sha256: actual };
}
async function archive(url, name, folder, prefix, hash) {
  const dest = path.join(root, ".runtime", name);
  await download(url, dest, hash);
  const unpack = path.join(root, ".runtime/unpack", folder);
  await mkdir(unpack, { recursive: true });
  execFileSync("cmake", ["-E", "tar", "xf", dest], {
    cwd: unpack,
    stdio: "inherit",
  });
  const source = prefix ? path.join(unpack, prefix) : unpack;
  return source;
}
const { copyFile, readdir } = await import("node:fs/promises");
const zstd = await archive(
  "https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz",
  "zstd-1.5.7.tar.gz",
  "zstd",
  "zstd-1.5.7",
  "eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3",
);
const { cp } = await import("node:fs/promises");
await mkdir(path.join(vendor, "zstd"), { recursive: true });
for (const item of ["lib", "build/cmake", "LICENSE", "COPYING"])
  await cp(path.join(zstd, item), path.join(vendor, "zstd", item), {
    recursive: true,
  });
const sql = await archive(
  "https://www.sqlite.org/2026/sqlite-amalgamation-3540100.zip",
  "sqlite.zip",
  "sqlite",
  "sqlite-amalgamation-3540100",
  "0a9c8e34352dad46006aa82836d5383bff9dc6bc9ce5a60553c05aa30e6ad1f9",
);
await mkdir(path.join(vendor, "sqlite"), { recursive: true });
for (const f of ["sqlite3.c", "sqlite3.h", "sqlite3ext.h"])
  await copyFile(path.join(sql, f), path.join(vendor, "sqlite", f));
const vec = await archive(
  "https://github.com/asg017/sqlite-vec/releases/download/v0.1.9/sqlite-vec-0.1.9-amalgamation.zip",
  "vec.zip",
  "vec",
  "",
  "b87cdda12112657ba5ab8842f0088a4090982eaf41f22b2bd6d495b81765a8c9",
);
await mkdir(path.join(vendor, "vec"), { recursive: true });
async function find(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.name === name) return p;
    if (entry.isDirectory()) {
      const v = await find(p, name);
      if (v) return v;
    }
  }
}
for (const f of ["sqlite-vec.c", "sqlite-vec.h"])
  await copyFile(await find(vec, f), path.join(vendor, "vec", f));
await download(
  "https://raw.githubusercontent.com/yhirose/cpp-httplib/v0.63.0/httplib.h",
  path.join(vendor, "httplib.h"),
  "9021001a719768893a8a6e4051c56107690e8b8e49b41e5f903534fa19ae9afb",
);
await download(
  "https://raw.githubusercontent.com/nlohmann/json/v3.12.0/single_include/nlohmann/json.hpp",
  path.join(vendor, "json.hpp"),
  "aaf127c04cb31c406e5b04a63f1ae89369fccde6d8fa7cdda1ed4f32dfc5de63",
);
if (process.argv.includes('--model')) {
  const {ensureModel}=await import('./model.mjs');
  await ensureModel();
}
await writeFile(
  path.join(root, ".runtime/downloads.json"),
  JSON.stringify(lock, null, 2),
);
console.log(`Native dependencies ready. Data: ${home}`);
