import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const npmStub = `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const file=(name)=>path.join(root,name);
const write=(name,value)=>{
  fs.mkdirSync(path.dirname(file(name)),{recursive:true});
  fs.writeFileSync(file(name),value);
};
const command=process.argv[2];
fs.appendFileSync(file('npm-calls.log'),process.argv.slice(2).join(' ')+'\\n');
if(command==='ls') {
  try {
    const lock=JSON.parse(fs.readFileSync(file('package-lock.json')));
    for(const [name,entry] of Object.entries(lock.packages)) {
      if(name && JSON.parse(fs.readFileSync(file(name+'/package.json'))).version!==entry.version) process.exit(1);
    }
    process.exit(0);
  } catch {process.exit(1);}
}
if(command!=='ci' && command!=='install') process.exit(2);
if(fs.existsSync(file('interrupt-install'))) {
  write('node_modules/partial','unfinished');
  process.exit(1);
}
const lock=JSON.parse(fs.readFileSync(file('package-lock.json')));
for(const [name,entry] of Object.entries(lock.packages)) {
  if(name) write(name+'/package.json',JSON.stringify(entry));
}
const installed={packages:Object.fromEntries(Object.entries(lock.packages).filter(([name])=>name))};
write('node_modules/.package-lock.json',JSON.stringify(installed));
for(const name of ['tsc','vite']) {
  write('node_modules/.bin/'+name,'#!/bin/sh\\nexit 0\\n');
  fs.chmodSync(file('node_modules/.bin/'+name),0o755);
}
`;

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "fieldnote-dependencies-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "scripts"));
  await mkdir(path.join(directory, "bin"));
  await copyFile(new URL("../scripts/ensure-dependencies.mjs", import.meta.url),
    path.join(directory, "scripts", "ensure-dependencies.mjs"));
  const manifest = { name: "fixture", version: "1.0.0", type: "module",
    devDependencies: { vite: "^1.0.0", typescript: "^1.0.0" } };
  const lock = { lockfileVersion: 3, packages: {
    "": manifest,
    "node_modules/vite": { version: "1.0.0", integrity: "fixture-vite" },
    "node_modules/typescript": { version: "1.0.0", integrity: "fixture-ts" },
  } };
  await writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
  await writeFile(path.join(directory, "package-lock.json"), JSON.stringify(lock));
  await writeFile(path.join(directory, "bin", "npm"), npmStub, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, ["scripts/ensure-dependencies.mjs"], {
    cwd: directory,
    env: { ...process.env, PATH: `${directory}/bin:${process.env.PATH}` },
    encoding: "utf8",
  });
  const calls = async () => (await readFile(path.join(directory, "npm-calls.log"), "utf8"))
    .trim().split("\n");
  return { directory, run, calls, lock };
}

test("launcher dependency setup retries an interrupted install and then works offline", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "interrupt-install"), "");
  const failed = f.run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Dependency installation failed/);
  await access(path.join(f.directory, "node_modules", "partial"));
  await assert.rejects(access(path.join(f.directory, "node_modules", ".fieldnote-install")));
  await rm(path.join(f.directory, "interrupt-install"));
  assert.equal(f.run().status, 0);
  assert.equal(f.run().status, 0);
  assert.deepEqual(await f.calls(), [
    "ci --include=dev", "ci --include=dev", "ls --all --include=dev --offline",
    "ls --all --include=dev --offline",
  ]);
});

test("changed lockfiles and missing dependencies trigger repair", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  f.lock.packages["node_modules/vite"].version = "1.1.0";
  await writeFile(path.join(f.directory, "package-lock.json"), JSON.stringify(f.lock));
  assert.equal(f.run().status, 0);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, "node_modules/vite/package.json"))).version, "1.1.0");
  await rm(path.join(f.directory, "node_modules/typescript/package.json"));
  assert.equal(f.run().status, 0);
  await rm(path.join(f.directory, "node_modules/.bin/vite"));
  assert.equal(f.run().status, 0);
  assert.equal((await f.calls()).filter((line) => line.startsWith("ci ")).length, 4);
});

test("healthy pre-helper installations are adopted without downloading", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  await rm(path.join(f.directory, "node_modules/.fieldnote-install"));
  await writeFile(path.join(f.directory, "interrupt-install"), "");
  assert.equal(f.run().status, 0, "adoption must work even when installation is unavailable");
  assert.equal((await f.calls()).filter((line) => line.startsWith("ci ")).length, 1);
  await access(path.join(f.directory, "node_modules/.fieldnote-install"));
});

test("an interrupted repair cannot retain a success marker", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  await rm(path.join(f.directory, "node_modules/.bin/tsc"));
  await writeFile(path.join(f.directory, "interrupt-install"), "");
  assert.equal(f.run().status, 1);
  await assert.rejects(access(path.join(f.directory, "node_modules/.fieldnote-install")));
  await rm(path.join(f.directory, "interrupt-install"));
  assert.equal(f.run().status, 0);
});
