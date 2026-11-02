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
      if(entry.optional && !fs.existsSync(file(name+'/package.json'))) continue;
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
  if(entry.optional && fs.existsSync(file('omit-bindings'))) continue;
  if(name) write(name+'/package.json',JSON.stringify(entry));
}
const installed={packages:Object.fromEntries(Object.entries(lock.packages).filter(([name])=>name))};
write('node_modules/.package-lock.json',JSON.stringify(installed));
for(const name of ['tsc','vite']) {
  write('node_modules/.bin/'+name,${JSON.stringify(`#!${process.execPath}\nimport '@typescript/native-test';\n`)});
  fs.chmodSync(file('node_modules/.bin/'+name),0o755);
}
write('node_modules/vite/index.js',"import '@rolldown/binding-test';\\n");
if(!fs.existsSync(file('omit-bindings'))) {
  write('node_modules/@rolldown/binding-test/index.js','export {};\\n');
  write('node_modules/@typescript/native-test/index.js','export {};\\n');
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
    "node_modules/vite": { version: "1.0.0", integrity: "fixture-vite", type: "module", main: "index.js" },
    "node_modules/typescript": { version: "1.0.0", integrity: "fixture-ts" },
    "node_modules/@rolldown/binding-test": { version: "1.0.0", optional: true, type: "module", main: "index.js" },
    "node_modules/@typescript/native-test": { version: "1.0.0", optional: true, type: "module", main: "index.js" },
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
    "ci --include=dev --include=optional", "ci --include=dev --include=optional", "ls --all --include=dev --offline",
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

test("missing optional toolchain bindings trigger repair even when npm ls passes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  for (const name of ["@rolldown/binding-test", "@typescript/native-test"]) {
    await rm(path.join(f.directory, "node_modules", name), { recursive: true });
    const listing = spawnSync(path.join(f.directory, "bin/npm"), ["ls", "--all", "--include=dev", "--offline"], {
      cwd: f.directory, encoding: "utf8",
    });
    assert.equal(listing.status, 0, "npm ls alone accepts the missing optional binding");
    const repaired = f.run();
    assert.equal(repaired.status, 0, repaired.stderr);
    await access(path.join(f.directory, "node_modules", name, "index.js"));
  }
  assert.equal((await f.calls()).filter((line) => line.startsWith("ci ")).length, 3);
});

test("installation success without required bindings cannot write a success marker", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "omit-bindings"), "");
  const failed = f.run();
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /installation is incomplete/);
  await assert.rejects(access(path.join(f.directory, "node_modules/.fieldnote-install")));
  await rm(path.join(f.directory, "omit-bindings"));
  assert.equal(f.run().status, 0);
});
