import fs from "node:fs/promises";
import { writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  getActiveConfig,
  getTextProviderBaseUrl,
  type AIConfig,
} from "./ai.js";
import { CreativeError } from "./creative-model.js";
import {
  approveCreativeProject,
  requireCreativeRevision,
  saveCreativeProject,
  validateCreativeMedia,
  withCreativeMutation,
} from "./creative-projects.js";
import { inspectCreativeSource } from "./creative-renderer.js";
import { STORAGE_ROOT } from "../utils/paths.js";
import { ffmpegPath } from "../utils/ffmpeg.js";
import {
  runProviderTool,
  providerToolSpecs,
  type ProviderContext,
} from "./production-tools/providers.js";

const exec = promisify(execFile);
export const speechVoices = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
] as const;
const voiceSchema = z.enum(speechVoices);
export const speechDependencies = {
  config: (type: "speech" | "transcription") => getActiveConfig(type),
  fetch: globalThis.fetch,
};
type Dependencies = typeof speechDependencies;
const jobs = new Set<string>();
async function exclusive<T>(key: string, work: () => Promise<T>) {
  if (jobs.has(key))
    throw new CreativeError("语音任务正在执行，请等待完成", 409);
  jobs.add(key);
  try {
    return await work();
  } finally {
    jobs.delete(key);
  }
}
async function settings(deps: Dependencies, type: "speech" | "transcription") {
  const config = await deps.config(type);
  if (!config || !config.apiKey)
    throw new CreativeError(
      "请在模型与服务中启用对应的语音合成或语音识别配置",
      503,
    );
  return {
    ...config,
    url: getTextProviderBaseUrl(config).replace(/\/$/, ""),
    headers: { Authorization: `Bearer ${config.apiKey}` },
  };
}
function speechTool(config: AIConfig) {
  const candidates = Object.entries(providerToolSpecs).filter(
    ([, spec]) =>
      spec.serviceType === "speech" && spec.provider === config.provider,
  );
  const selected =
    candidates.find(([, spec]) => spec.model === config.model) ?? candidates[0];
  if (!selected)
    throw new CreativeError(
      "当前语音配置没有可执行的合成接口，请在模型与服务中选择受支持的语音服务",
      503,
    );
  return selected[0];
}
/** Persist remote task IDs and prepared audio so retries cannot repeat an uncertain paid submission. */
async function providerAudio(
  id: number,
  dir: string,
  hash: string,
  toolId: string,
  args: Record<string, unknown>,
  config: AIConfig,
  deps: Dependencies,
) {
  const outputDir = path.join(dir, `speech-tool-${hash}`),
    stateFile = path.join(dir, `speech-state-${hash}.json`);
  await fs.mkdir(outputDir, { recursive: true });
  let state: Record<string, unknown> = {};
  try {
    const stored = JSON.parse(await fs.readFile(stateFile, "utf8"));
    if (stored && typeof stored === "object" && !Array.isArray(stored))
      state = stored;
  } catch {
    /* first attempt */
  }
  const checkpoint = (update: Record<string, unknown>) => {
    Object.assign(state, update);
    const temporary = `${stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state));
    renameSync(temporary, stateFile);
  };
  if (typeof state.mediaFile === "string")
    try {
      const root = await fs.realpath(outputDir),
        file = await fs.realpath(state.mediaFile);
      if (file.startsWith(root + path.sep) && (await fs.stat(file)).isFile())
        return file;
    } catch {
      /* recover through remote task below */
    }
  if (state.remoteId) checkpoint({ pollStarted: Date.now() });
  const context: ProviderContext = {
    projectId: id,
    toolId,
    args,
    outputDir,
    signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
    config,
    state,
    checkpoint,
    progress: () => {},
  };
  const result = await runProviderTool(context, { fetch: deps.fetch }),
    audio = result.files.find((file) => file.kind === "audio");
  if (!audio) throw new CreativeError("语音服务未返回音频产物", 422);
  checkpoint({ mediaFile: audio.path });
  return audio.path;
}
async function folder(id: number) {
  const root = await fs.realpath(STORAGE_ROOT),
    target = path.join(root, "creative", String(id));
  await fs.mkdir(target, { recursive: true });
  const real = await fs.realpath(target);
  if (!real.startsWith(root + path.sep))
    throw new CreativeError("语音输出目录无效");
  return real;
}
async function convert(args: string[]) {
  try {
    await exec(
      ffmpegPath || "ffmpeg",
      ["-hide_banner", "-loglevel", "error", "-y", ...args],
      { timeout: 180000, maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new CreativeError(
      "音频处理失败，请检查原片音轨和本地视频处理工具",
      422,
    );
  }
}
async function respond(request: Promise<Response>) {
  let response: Response;
  try {
    response = await request;
  } catch {
    throw new CreativeError("语音服务连接失败或超时，请检查配置后重试", 503);
  }
  if (!response.ok)
    throw new CreativeError(
      `语音服务请求失败（${response.status}），请检查服务权限、额度和配置`,
      503,
    );
  return response;
}
const transcriptSchema = z.object({
  segments: z
    .array(
      z.object({
        start: z.number().finite().min(0),
        end: z.number().finite().positive(),
        text: z.string().trim().min(1).max(3000),
      }),
    )
    .min(1)
    .max(2000),
});
function timestamp(seconds: number) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

/** Explicit user action: extract only audio, then store real timestamped ASR output. */
export async function transcribeCreativeSource(
  id: number,
  revision: number,
  sourceId: string,
  deps: Dependencies = speechDependencies,
) {
  return exclusive(`transcript:${id}:${sourceId}`, async () => {
    const project = requireCreativeRevision(id, revision),
      source = project.production.sources.find((s) => s.id === sourceId);
    if (!source || source.kind === "image" || !source.duration)
      throw new CreativeError("请选择有声音的视频或音频素材");
    if (source.duration > 3600)
      throw new CreativeError("请将超过60分钟的原片拆分后识别");
    if (source.transcript.trim())
      throw new CreativeError(
        "已有原稿，请先核对；如需重新识别，清空并保存原稿后再试",
      );
    validateCreativeMedia(id, source.url, source.kind);
    const config = await settings(deps, "transcription"),
      dir = await folder(id);
    const sourcePath = path.join(
      STORAGE_ROOT,
      source.url!.slice("/static/".length),
    );
    const stat = await fs.stat(sourcePath);
    const hash = createHash("sha256")
      .update(
        JSON.stringify([
          source.url,
          stat.size,
          stat.mtimeMs,
          config.provider,
          config.id,
          config.url,
          config.model,
          config.serviceOptions,
        ]),
      )
      .digest("hex");
    const cache = path.join(dir, `transcript-${hash}.json`);
    let result: z.infer<typeof transcriptSchema> | undefined;
    try {
      result = transcriptSchema.parse(
        JSON.parse(await fs.readFile(cache, "utf8")),
      );
    } catch {
      /* no reusable result */
    }
    if (!result) {
      const temp = await fs.mkdtemp(
        path.join(os.tmpdir(), "video-factory-asr-"),
      );
      try {
        if (config.provider === "openai") {
          const audio = path.join(temp, "source.mp3");
          await convert([
            "-i",
            sourcePath,
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-b:a",
            "32k",
            audio,
          ]);
          const bytes = await fs.readFile(audio);
          if (bytes.length > 24 * 1024 * 1024)
            throw new CreativeError("压缩后音频仍过大，请拆分原片后识别");
          const form = new FormData();
          form.set(
            "file",
            new Blob([bytes], { type: "audio/mpeg" }),
            "source.mp3",
          );
          form.set("model", config.model);
          form.set("response_format", "verbose_json");
          form.append("timestamp_granularities[]", "segment");
          const response = await respond(
            deps.fetch(`${config.url}/audio/transcriptions`, {
              method: "POST",
              headers: config.headers,
              body: form,
              signal: AbortSignal.timeout(180000),
              redirect: "error",
            }),
          );
          const parsed = transcriptSchema.safeParse(await response.json());
          if (!parsed.success)
            throw new CreativeError("语音服务未返回有效的逐字稿与时码", 422);
          result = parsed.data;
        } else if (config.provider === "azure") {
          if (source.duration > 60)
            throw new CreativeError(
              "当前 Azure 识别接口支持 60 秒以内原片；长片请选择 OpenAI 时码识别配置",
              422,
            );
          const audio = path.join(dir, `asr-prepared-${hash}.wav`);
          try {
            await convert([
              "-i",
              sourcePath,
              "-map",
              "0:a:0",
              "-vn",
              "-ac",
              "1",
              "-ar",
              "16000",
              "-c:a",
              "pcm_s16le",
              audio,
            ]);
            const output = await runProviderTool(
              {
                projectId: id,
                toolId: "azure_stt",
                args: {
                  ...config.serviceOptions,
                  audio_url: `/static/creative/${id}/${path.basename(audio)}`,
                },
                outputDir: dir,
                signal: AbortSignal.timeout(180000),
                config,
                state: {},
                checkpoint: () => {},
                progress: () => {},
              },
              { fetch: deps.fetch },
            );
            const parsed = transcriptSchema.safeParse(output.data);
            if (!parsed.success)
              throw new CreativeError(
                "当前识别服务未返回真实时码，请选择支持时码的识别模型",
                422,
              );
            result = parsed.data;
          } finally {
            await fs.rm(audio, { force: true });
          }
        } else {
          throw new CreativeError(
            "当前识别模型只提供文字，不能用于字幕时码；请选择 OpenAI 或 Azure 时码识别服务",
            422,
          );
        }
        await fs.writeFile(cache, JSON.stringify(result), "utf8");
      } finally {
        await fs.rm(temp, { recursive: true, force: true });
      }
    }
    let end = 0;
    const srt = result.segments
      .map((segment, i) => {
        if (
          segment.start < end ||
          segment.end <= segment.start ||
          segment.end > source.duration! + 0.1
        )
          throw new CreativeError(
            "识别时码重叠或超出原片，请核对原片后重试",
            422,
          );
        end = segment.end;
        return `${i + 1}\n${timestamp(segment.start)} --> ${timestamp(segment.end)}\n${segment.text}`;
      })
      .join("\n\n");
    if (srt.length > 60000)
      throw new CreativeError("识别原稿过长，请拆分项目后处理", 422);
    return withCreativeMutation(id, () =>
      saveCreativeProject(id, {
        ...project,
        production: {
          ...project.production,
          sources: project.production.sources.map((s) =>
            s.id === sourceId ? { ...s, transcript: srt } : s,
          ),
        },
      }),
    );
  });
}

/** One shot at a time: durable media cache makes resumed pipeline work reusable. */
export async function synthesizeCreativeShot(
  id: number,
  revision: number,
  shotId: string,
  deps: Dependencies = speechDependencies,
) {
  return exclusive(`speech:${id}:${shotId}`, async () => {
    const project = requireCreativeRevision(id, revision),
      shot = project.shots.find((s) => s.id === shotId);
    if (!shot || !shot.narration.trim())
      throw new CreativeError("该镜头没有旁白文字");
    if (shot.audioUrl) return project;
    const config = await settings(deps, "speech"),
      dir = await folder(id);
    const voice =
      config.provider === "openai"
        ? voiceSchema.parse(
            project.production.fields.speechVoice ||
              config.serviceOptions?.voice ||
              "coral",
          )
        : undefined;
    if (
      voice &&
      ["tts-1", "tts-1-hd"].includes(config.model) &&
      !["alloy", "echo", "fable", "onyx", "nova", "shimmer"].includes(voice)
    )
      throw new CreativeError(
        "当前配音模型不支持该音色，请选择 alloy、echo、fable、onyx、nova 或 shimmer",
        422,
      );
    const toolId = speechTool(config),
      argumentsForSpeech = {
        ...config.serviceOptions,
        text: shot.narration,
        response_format: "wav",
        ...(voice ? { voice } : {}),
      };
    const identity = [
      shot.narration,
      config.provider,
      config.id,
      config.url,
      config.model,
      argumentsForSpeech,
    ];
    const hash = createHash("sha256")
      .update(JSON.stringify([...identity, shot.duration]))
      .digest("hex");
    const name = `speech-${hash}.wav`,
      url = `/static/creative/${id}/${name}`,
      file = path.join(dir, name);
    try {
      validateCreativeMedia(id, url, "audio");
    } catch {
      const rawHash = createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex");
      const rawName = `speech-raw-${rawHash}.wav`,
        raw = path.join(dir, rawName),
        temp = path.join(dir, `speech-fit-${randomUUID()}.wav`);
      try {
        try {
          validateCreativeMedia(
            id,
            `/static/creative/${id}/${rawName}`,
            "audio",
          );
        } catch {
          const generated = await providerAudio(
            id,
            dir,
            rawHash,
            toolId,
            argumentsForSpeech,
            config,
            deps,
          );
          const staging = path.join(dir, `speech-download-${randomUUID()}.wav`);
          try {
            await convert([
              "-i",
              generated,
              "-vn",
              "-ar",
              "48000",
              "-ac",
              "2",
              "-c:a",
              "pcm_s16le",
              staging,
            ]);
            await fs.rename(staging, raw);
          } finally {
            await fs.rm(staging, { force: true });
          }
        }
        const info = await inspectCreativeSource(
          id,
          `/static/creative/${id}/${rawName}`,
          false,
        );
        if (!info.duration)
          throw new CreativeError("无法读取合成语音时长", 422);
        const speed = Math.max(1, info.duration / shot.duration);
        if (speed > 1.5)
          throw new CreativeError(
            `镜头「${shot.title}」旁白过长，请精简文字或增加镜头时长`,
            422,
          );
        await convert([
          "-i",
          raw,
          "-af",
          `atempo=${speed},apad`,
          "-t",
          String(shot.duration),
          "-ar",
          "48000",
          "-ac",
          "2",
          "-c:a",
          "pcm_s16le",
          temp,
        ]);
        await fs.rename(temp, file);
      } finally {
        await fs.rm(temp, { force: true });
      }
    }
    return withCreativeMutation(id, () => {
      const saved = saveCreativeProject(id, {
        ...project,
        shots: project.shots.map((s) =>
          s.id === shotId
            ? {
                ...s,
                audioUrl: url,
                audioTrimStart: 0,
                ...(project.category === "localization"
                  ? { originalVolume: 0 }
                  : {}),
              }
            : s,
        ),
      });
      // Only generated media changed; the already approved script and timing remain intact.
      return project.approvedRevision === revision
        ? approveCreativeProject(id, saved.revision)
        : saved;
    });
  });
}
