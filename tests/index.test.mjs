import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
const exe = path.resolve("dist/native/better-search.exe");
const fingerprint =
  "68bae29d62fb8c7d23e98d21fd4662753ddd636e6b62b8a70dfe059a9844f216";
import {testModelFile as modelFile} from './helpers/model.mjs';
const fixture = await mkdtemp(path.resolve(".runtime/test-"));
const source = path.join(fixture, "source");
await mkdir(source, { recursive: true });
const s = new DatabaseSync(path.join(source, "state_5.sqlite"));
s.exec(
  "CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,project_id TEXT,git_origin_url TEXT,git_branch TEXT); CREATE TABLE projects(id TEXT,name TEXT); CREATE TABLE thread_spawn_edges(parent_thread_id TEXT,child_thread_id TEXT)",
);
s.prepare("INSERT INTO projects VALUES(?,?)").run("p1", "Search Test");
for (const [id, title, archived] of [
  ["a", "OAuth Login " + "x".repeat(30000), 0],
  ["b", "Datenbank Migration", 1],
])
  s.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(
    id,
    title,
    "C:\\test\\repo",
    100,
    200,
    archived,
    "p1",
    "https://private-token@example.org/team/repo.git",
    "main",
  );
s.prepare("INSERT INTO thread_spawn_edges VALUES(?,?)").run("a", "b");
s.close();
const h = new DatabaseSync(path.join(source, "thread_history_1.sqlite"));
h.exec(
  "CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT,updated_at_ordinal INTEGER)",
);
const insert = h.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)");
insert.run(
  "a",
  "turn1",
  "user1",
  1,
  100,
  "userMessage",
  JSON.stringify({
    type: "userMessage",
    content: [{ type: "text", text: "Wie funktioniert OAuth Anmeldung? 🌱" }],
  }),
  1,
);
insert.run(
  "a",
  "turn1",
  "assistant1",
  2,
  101,
  "agentMessage",
  JSON.stringify({
    type: "agentMessage",
    text: "Verwende PKCE für den Login. ".repeat(200) + " <script>alert('x')</script> Änderungsdiagnose 🌱 session_id src/ui.ts e\u0301",
  }),
  2,
);
insert.run(
  "a",
  "turn1",
  "reasoning",
  3,
  102,
  "reasoning",
  JSON.stringify({ text: "DO_NOT_INDEX_REASONING" }),
  3,
);
insert.run(
  "a",
  "turn1",
  "tool",
  4,
  102,
  "commandExecution",
  JSON.stringify({ output: "DO_NOT_INDEX_TOOL_OUTPUT" }),
  4,
);
insert.run(
  "b",
  "turn2",
  "user2",
  1,
  100,
  "userMessage",
  JSON.stringify({
    type: "userMessage",
    content: [{ type: "text", text: "SQLite Migration für das Schema." }],
  }),
  1,
);
h.close();
const legacy = path.join(source, "archived_sessions");
await mkdir(legacy);
await writeFile(
  path.join(legacy, "legacy.jsonl"),
  [
    {
      type: "session_meta",
      payload: {
        id: "legacy",
        cwd: "C:\\test\\legacy",
        timestamp: "2026-01-01T00:00:00Z",
      },
    },
    {
      type: "event_msg",
      payload: { type: "user_message", message: "Legacy Nachricht" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "legacy1",
        role: "user",
        content: [{ type: "input_text", text: "Legacy Nachricht" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "legacy2",
        role: "assistant",
        content: [
          { type: "output_text", text: "Antwort mit Umlauten äöü und 🌱" },
        ],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "legacy3",
        role: "user",
        content: [{ type: "input_text", text: "Legacy Nachricht" }],
      },
    },
  ]
    .map((x) => JSON.stringify(x))
    .join("\n") + '\n{"incomplete":',
);
const home = path.join(fixture, "data");
await writeFile(
  path.join(legacy, "compressed.jsonl.zst"),
  zstdCompressSync(
    Buffer.from(
      [
        {
          type: "session_meta",
          payload: {
            id: "compressed",
            cwd: "C:\\test\\compressed",
            timestamp: "2026-01-02T00:00:00Z",
            base_instructions:
              "DO_NOT_INDEX_BASE_INSTRUCTIONS " + "x".repeat(150000),
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            id: "compressed1",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Komprimierter Chat mit Zstandard und Umlauten äöü 🌱",
              },
            ],
          },
        },
      ]
        .map((x) => JSON.stringify(x))
        .join("\n") + "\n",
    ),
  ),
);
await mkdir(home);
await writeFile(
  path.join(home, "config.json"),
  JSON.stringify({
    model: "google/embeddinggemma-2",
    model_file: "embeddinggemma-2-BF16.gguf",
    model_sha256: fingerprint,
    dimensions: 768,
    sources: [
      { id: "test", label: "Fixture", kind: "local", codex_home: source },
      { id: "second", label: "Second", kind: "mirror", codex_home: source },
    ],
  }),
);
const sourceFiles = ["state_5.sqlite", "thread_history_1.sqlite"];
const checksums = await Promise.all(
  sourceFiles.map(async (f) =>
    createHash("sha256")
      .update(await readFile(path.join(source, f)))
      .digest("hex"),
  ),
);
let status;
test("native utilities preserve UTF-8 and strip injected environment metadata", () => {
  assert.match(
    execFileSync(exe, ["--self-test"], { encoding: "utf8" }),
    /passed/,
  );
});
test("imports paginated and legacy sources without modifying source databases", async () => {
  status = JSON.parse(
    execFileSync(exe, ["--data", home, "--index-only"], { encoding: "utf8" }),
  );
  assert.equal(status.threads, 8);
  assert.ok(status.chunks >= 10);
  assert.equal(status.metadata_only, 0);
  for (let i = 0; i < sourceFiles.length; i++)
    assert.equal(
      createHash("sha256")
        .update(await readFile(path.join(source, sourceFiles[i])))
        .digest("hex"),
      checksums[i],
    );
  const db = new DatabaseSync(path.join(home, "search.sqlite"), {
    readOnly: true,
  });
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM chunks WHERE text LIKE '%DO_NOT_INDEX%'")
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM chunks WHERE text='Legacy Nachricht'")
      .get().n,
    4,
  );
  assert.equal(
    db
      .prepare(
        "SELECT count(*) n FROM chunks WHERE text LIKE 'Komprimierter Chat mit Zstandard%'",
      )
      .get().n,
    2,
  );
  assert.equal(
    db.prepare("SELECT repo FROM threads WHERE key='test:a'").get().repo,
    "example.org/team/repo",
  );
  db.close();
});
test("incremental import preserves chunk IDs when history is unchanged", () => {
  const before = new DatabaseSync(path.join(home, "search.sqlite"), {
    readOnly: true,
  });
  const ids = before.prepare("SELECT id FROM chunks ORDER BY id").all();
  before.close();
  execFileSync(exe, ["--data", home, "--index-only"], { encoding: "utf8" });
  const after = new DatabaseSync(path.join(home, "search.sqlite"), {
    readOnly: true,
  });
  assert.deepEqual(
    after.prepare("SELECT id FROM chunks ORDER BY id").all(),
    ids,
  );
  after.close();
});

test("project rename refreshes metadata without replacing chunks or vectors", () => {
  const db=new DatabaseSync(path.join(home,"search.sqlite"),{readOnly:true});
  const before=db.prepare("SELECT id,digest,embedded FROM chunks ORDER BY id").all();db.close();
  const sourceDb=new DatabaseSync(path.join(source,"state_5.sqlite"));
  sourceDb.prepare("UPDATE projects SET name=? WHERE id='p1'").run("Search Renamed");sourceDb.close();
  execFileSync(exe,["--data",home,"--index-only"],{encoding:"utf8"});
  const after=new DatabaseSync(path.join(home,"search.sqlite"),{readOnly:true});
  assert.deepEqual(after.prepare("SELECT id,digest,embedded FROM chunks ORDER BY id").all(),before);
  assert.equal(after.prepare("SELECT name FROM projects WHERE key='test:p1'").get().name,"Search Renamed");after.close();
});
test(
  "native llama.cpp embeds fixture chunks using the downloaded EmbeddingGemma 2 model",
  { skip: !existsSync(modelFile) },
  async () => {
    const config = JSON.parse(
      await readFile(path.join(home, "config.json"), "utf8"),
    );
    config.model_file = modelFile;
    await writeFile(path.join(home, "config.json"), JSON.stringify(config));
    const embedded = JSON.parse(
      execFileSync(exe, ["--data", home, "--embed-only"], {
        encoding: "utf8",
        timeout: 180000,
      }),
    );
    assert.equal(embedded.embedded, embedded.chunks);
    assert.ok(embedded.embedded > 0);
  },
);
test('parallel embedding preserves document order and matches serial inference',{skip:!existsSync(modelFile)},()=>{
  const report=JSON.parse(execFileSync(exe,['--data',home,'--benchmark','--count','8','--verify-serial'],{encoding:'utf8',timeout:180000,env:{...process.env,BETTER_SEARCH_EMBED_WORKERS:'2'}}));
  assert.ok(report.min_serial_cosine>=0.99999);
  assert.ok(report.performance.workers>=1 && report.performance.workers<=4);
  assert.equal(report.performance.batch_documents,4);
});
test(
  "incremental import reuses vectors for unchanged text when a new message arrives",
  { skip: !existsSync(modelFile) },
  () => {
    const before = JSON.parse(
      execFileSync(exe, ["--data", home, "--status"], { encoding: "utf8" }),
    );
    const history = new DatabaseSync(
      path.join(source, "thread_history_1.sqlite"),
    );
    history.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)").run(
      "b",
      "turn3",
      "new-user",
      2,
      200,
      "userMessage",
      JSON.stringify({
        type: "userMessage",
        content: [
          {
            type: "text",
            text: "Eine zusätzliche Migration mit einem neuen Index.",
          },
        ],
      }),
      2,
    );
    history.close();
    const after = JSON.parse(
      execFileSync(exe, ["--data", home, "--index-only"], { encoding: "utf8" }),
    );
    assert.equal(after.chunks, before.chunks + 2);
    assert.equal(after.embedded, before.embedded);
  },
);
test("local API enforces origin and authentication; keyword results respect source and archive filters", async () => {
  // A long chat occupies the first candidate window; six distinct chats must still surface.
  const stateDb=new DatabaseSync(path.join(source,"state_5.sqlite"));
  const historyDb=new DatabaseSync(path.join(source,"thread_history_1.sqlite"));
  for(let i=0;i<7;i++){
    const id=`candidate-${i}`;
    stateDb.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?)").run(id,`Candidate ${i}`,"C:\\test\\repo",100,200,0,"p1","","main");
    for(let n=0;n<(i===0?140:1);n++)historyDb.prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)").run(id,'turn',`item-${n}`,n,100,'userMessage',JSON.stringify({type:'userMessage',content:[{type:'text',text:i===0?'sharedneedle':`sharedneedle ${'additional context '.repeat(20)}`}]}),n);
  }
  stateDb.close();historyDb.close();
  execFileSync(exe,["--data",home,"--index-only"],{encoding:"utf8"});
  const token = randomBytes(32).toString("hex");
  const tokenFile = path.join(home, "token");
  await writeFile(tokenFile, token);
  const port = 39571;
  const child = spawn(
    exe,
    [
      "--data",
      home,
      "--token-file",
      tokenFile,
      "--port",
      String(port),
      "--no-watch",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {}
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(ready);
    const call = async (method, params = {}, headers = {}) =>
      fetch(`http://127.0.0.1:${port}/api`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...headers,
        },
        body: JSON.stringify({ method, params }),
      });
    assert.equal(
      (await call("search_status", {}, { Authorization: "Bearer wrong" }))
        .status,
      403,
    );
    assert.equal(
      (await call("search_status", {}, { Origin: "https://untrusted.example" }))
        .status,
      403,
    );
    let r = await (
      await call("search_chats", {
        query: "OAuth",
        mode: "keyword",
        source_id: "test",
      })
    ).json();
    assert.equal(r.result.results.length, 1);
    assert.equal(r.result.results[0].key, "test:a");
    r = await (
      await call("search_chats", {
        query: "Migration",
        mode: "keyword",
        include_archived: false,
      })
    ).json();
    assert.equal(r.result.results.length, 0);
    const compact=async(query,extra={})=>(await (await call("search_chats",{query,mode:"keyword",presentation:"palette-v1",source_id:"test",...extra})).json()).result;
    const snippet=await compact("Änderungsdiag");
    assert.equal(snippet.results[0].key,"test:a");
    assert.ok(snippet.results[0].snippet.segments.some(s=>s.matched&&s.text.includes("Änderungsdiagnose")));
    assert.ok(!snippet.results[0].snippet.segments.map(s=>s.text).join("").startsWith("Verwende PKCE"));
    assert.equal(snippet.results[0].navigation.url,"codex://threads/a");
    const remote=await compact("Änderungsdiag",{source_id:"second"});
    assert.equal(remote.results[0].navigation.kind,"unavailable");
    const metadata=await compact("Search Renamed");
    assert.ok(metadata.results.every(r=>r.snippet.provenance==="metadata"));
    const unique=await compact("sharedneedle",{limit:6});
    assert.equal(new Set(unique.results.map(r=>r.key)).size,6);
    for(const query of ['session_id','src/ui.ts','OR * : { }','🌱','äöü']){
      const a=await compact(query),b=await compact(query);
      assert.deepEqual(a.results.map(r=>r.key),b.results.map(r=>r.key));
    }
    const stale=await (await call("search_chats",{session_id:"stale-test",request_id:2,cancel:true})).json();
    assert.equal(stale.result.discarded,true);
    const older=await (await call("search_chats",{query:"OAuth",mode:"hybrid",session_id:"stale-test",request_id:1})).json();
    assert.equal(older.result.discarded,true);
    if (existsSync(modelFile)) {
      r = await (
        await call("search_chats", {
          query: "secure sign-in with OAuth authorization",
          mode: "semantic",
          source_id: "test",
          limit: 1,
        })
      ).json();
      assert.equal(r.result?.results[0]?.key, "test:a", JSON.stringify(r));
      assert.ok(r.result.results[0].matches[0].similarity > 0);
      const constrained = await (await call("search_chats", {
        query: 'secure sign-in with OAuth authorization "SQLite"', mode: "semantic", source_id: "test", limit: 1,
        updated_after: "1970-01-01", updated_before: "1970-01-01",
      })).json();
      assert.equal(constrained.result?.results[0]?.key, "test:b", JSON.stringify(constrained));
      const excluded = await (await call("search_chats", {
        query: 'secure sign-in with OAuth authorization "SQLite"', mode: "semantic", source_id: "test",
        updated_after: "2026-01-01",
      })).json();
      assert.deepEqual(excluded.result?.results, [], JSON.stringify(excluded));
    }
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status,404);
    for(const query of ['', '  ', '\n\t'])assert.deepEqual((await compact(query)).results,[]);
    const first=await compact('sharedneedle',{limit:2,session_id:'pagination',request_id:1});
    assert.equal(first.results.length,2);assert.ok(first.snapshot_id);
    const changed=new DatabaseSync(path.join(home,'search.sqlite'));
    changed.exec("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='corpus_revision'");changed.close();
    const next=await compact('sharedneedle',{limit:2,offset:2,session_id:'pagination',request_id:1,snapshot_id:first.snapshot_id});
    assert.equal(next.corpusRevision,first.corpusRevision);assert.equal(next.results.length,2);
    assert.equal(new Set([...first.results,...next.results].map(r=>r.key)).size,4);
  } finally {
    if(child.exitCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill();await exited;}
  }
});


test('complete scans remove deleted chats while incompatible sources retain indexed data',()=>{
  const sourceDb=new DatabaseSync(path.join(source,'state_5.sqlite'));sourceDb.exec("DELETE FROM threads WHERE id='b'");sourceDb.close();
  execFileSync(exe,['--data',home,'--index-only'],{encoding:'utf8'});
  const db=new DatabaseSync(path.join(home,'search.sqlite'),{readOnly:true});
  assert.equal(db.prepare("SELECT count(*) n FROM threads WHERE thread_id='b'").get().n,0);
  const count=db.prepare('SELECT count(*) n FROM threads').get().n;db.close();
  const broken=new DatabaseSync(path.join(source,'state_5.sqlite'));broken.exec('ALTER TABLE threads RENAME TO unsupported_threads');broken.close();
  execFileSync(exe,['--data',home,'--index-only'],{encoding:'utf8'});
  const after=new DatabaseSync(path.join(home,'search.sqlite'),{readOnly:true});
  assert.equal(after.prepare('SELECT count(*) n FROM threads').get().n,count);after.close();
});
