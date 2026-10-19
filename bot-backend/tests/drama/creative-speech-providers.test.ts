import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
const directory = await fs.mkdtemp(
  path.join(os.tmpdir(), "vf-speech-providers-"),
);
process.env.SQLITE_PATH = path.join(directory, "db.sqlite");
process.env.HUOBAO_DATA_DIR = directory;
process.env.STORAGE_PATH = path.join(directory, "static");
process.env.MYSQL_AUTO_IMPORT = "false";
const { db, schema, getInsertId } = await import("../../src/drama/db/index.js");
const { ffmpegPath } = await import("../../src/drama/utils/ffmpeg.js");
const { createCreativeDocument } = await import(
  "../../src/drama/services/creative-model.js"
);
const { getCreativeProject, saveCreativeProject, approveCreativeProject } =
  await import("../../src/drama/services/creative-projects.js");
const { synthesizeCreativeShot, transcribeCreativeSource } = await import(
  "../../src/drama/services/creative-speech.js"
);
const { inspectCreativeSource } = await import(
  "../../src/drama/services/creative-renderer.js"
);
let wav: Buffer;
before(async () => {
  await fs.mkdir(path.join(directory, "static", "uploads"), {
    recursive: true,
  });
  const file = path.join(directory, "static", "uploads", "voice.wav");
  execFileSync(ffmpegPath!, [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440",
    "-t",
    "1",
    "-c:a",
    "pcm_s16le",
    file,
  ]);
  wav = await fs.readFile(file);
});
after(async () => {
  db.$client.close();
  await fs.rm(directory, { recursive: true, force: true });
});
function project() {
  const document = createCreativeDocument("talking_head");
  document.production.fields.speechVoice = "coral";
  document.brief.idea = "场景";
  document.brief.targetDuration = 5;
  document.shots = [
    {
      id: "shot-one",
      title: "人物",
      duration: 3,
      narration: "外部服务的配音",
      caption: "",
      visualPrompt: "人物",
      mediaType: "image",
      imageUrl: null,
      videoUrl: null,
      audioUrl: null,
      audioTrimStart: 0,
      trimStart: 0,
      originalVolume: 1,
      imageTaskId: null,
      videoTaskId: null,
    },
  ];
  document.production.sources = [
    {
      id: randomUUID(),
      name: "原声",
      kind: "audio",
      url: "/static/uploads/voice.wav",
      duration: 1,
      coverUrl: null,
      transcript: "",
      attribution: "",
    },
  ];
  const ts = new Date().toISOString(),
    id = getInsertId(
      db
        .insert(schema.dramas)
        .values({
          title: "配音测试",
          projectType: "creative",
          creativeCategory: "talking_head",
          createdAt: ts,
          updatedAt: ts,
        })
        .run(),
    );
  db.insert(schema.creativeProjects)
    .values({
      projectId: id,
      document: JSON.stringify(document),
      revision: 1,
      updatedAt: ts,
    })
    .run();
  return getCreativeProject(id);
}
test("pipeline company speech posts the OpenAI-compatible contract and retains fitting/approval cache", async () => {
  let p = project();
  p = approveCreativeProject(p.id, p.revision);
  let calls = 0;
  const deps = {
    config: async () => ({
      id: 21,
      provider: "company",
      baseUrl: "https://company.invalid",
      apiKey: "company-token",
      model: "catalog-tts",
      serviceOptions: {},
    }),
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      assert.match(String(url), /api\/media\/speech$/);
      const body = JSON.parse(String(init!.body));
      assert.equal(body.model, "catalog-tts");
      assert.equal(body.input, "外部服务的配音");
      assert.equal(body.response_format, "wav");
      assert.equal(body.voice, "coral");
      return Response.json({
        ok: true,
        audio: { media_type: "audio/wav", base64: wav.toString("base64") },
      });
    },
  };
  const saved = await synthesizeCreativeShot(
    p.id,
    p.revision,
    p.shots[0].id,
    deps,
  );
  assert.equal(saved.approvedRevision, saved.revision);
  const info = await inspectCreativeSource(
    p.id,
    saved.shots[0].audioUrl!,
    false,
  );
  assert.ok(Math.abs(info.duration! - 3) < 0.04);
  const cleared = saveCreativeProject(p.id, {
      ...saved,
      shots: saved.shots.map((shot) => ({ ...shot, audioUrl: null })),
    }),
    cached = await synthesizeCreativeShot(
      p.id,
      cleared.revision,
      cleared.shots[0].id,
      deps,
    );
  assert.equal(calls, 1);
  assert.equal(cached.shots[0].audioUrl, saved.shots[0].audioUrl);
});
test("external speech caches completed provider audio across concurrent project edits", async () => {
  const p = project();
  let calls = 0;
  const deps = {
    config: async () => ({
      id: 22,
      provider: "company",
      baseUrl: "https://company.invalid",
      apiKey: "company-token",
      model: "catalog-tts",
      serviceOptions: {},
    }),
    fetch: async () => {
      calls++;
      saveCreativeProject(p.id, {
        ...getCreativeProject(p.id),
        title: "保留并发修改",
      });
      return Response.json({
        ok: true,
        audio: { media_type: "audio/wav", base64: wav.toString("base64") },
      });
    },
  };
  await assert.rejects(
    synthesizeCreativeShot(p.id, p.revision, p.shots[0].id, deps),
    /修改|更新|版本/,
  );
  const current = getCreativeProject(p.id),
    saved = await synthesizeCreativeShot(
      p.id,
      current.revision,
      current.shots[0].id,
      deps,
    );
  assert.equal(saved.title, "保留并发修改");
  assert.equal(calls, 1);
});
test("a failed Fal queue call resolves its attempt and the retry posts a fresh job", async () => {
  const p = project();
  let posts = 0;
  const deps = {
    config: async () => ({
      id: 23,
      provider: "fal",
      baseUrl: "https://company.invalid",
      apiKey: "company-token",
      model: "fal-ai/elevenlabs/tts/multilingual-v2",
    }),
    fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts++;
        // 队列端点是同步事务：一次失败的请求结果不可恢复，重试即新任务
        if (posts === 1) throw new Error("connection reset");
        assert.match(String(_url), /\/api\/media\/queue$/);
        return Response.json({
          ok: true,
          request_id: "fal-fresh",
          assets: [{ media_type: "audio/wav", base64: wav.toString("base64") }],
        });
      }
      throw new Error("unexpected GET");
    },
  };
  await assert.rejects(
    synthesizeCreativeShot(p.id, p.revision, p.shots[0].id, deps),
    /连接中断/,
  );
  assert.equal(posts, 1);
  const saved = await synthesizeCreativeShot(
    p.id,
    p.revision,
    p.shots[0].id,
    deps,
  );
  assert.equal(posts, 2);
  const info = await inspectCreativeSource(
    p.id,
    saved.shots[0].audioUrl!,
    false,
  );
  assert.ok(info.duration! > 0);
});
test("pipeline rejects text-only ASR output and never creates synthetic subtitle timing", async () => {
  const p = project();
  let calls = 0;
  const deps = {
    config: async () => ({
      id: 24,
      provider: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com",
      apiKey: "secret",
      model: "qwen3-asr-flash",
    }),
    fetch: async () => {
      calls++;
      return Response.json({ text: "文字" });
    },
  };
  await assert.rejects(
    transcribeCreativeSource(
      p.id,
      p.revision,
      p.production.sources[0].id,
      deps,
    ),
    /未返回有效的逐字稿与时码/,
  );
  assert.equal(calls, 1);
  assert.equal(getCreativeProject(p.id).production.sources[0].transcript, "");
});
