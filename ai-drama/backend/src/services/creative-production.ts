import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { now } from '../utils/response.js'
import { generateImage, generateVideo } from './generation.js'
import { renderCreativeVideo } from './creative-renderer.js'
import { getActiveConfig, getConfigById } from './ai.js'
import { CreativeError } from './creative-model.js'
import { getCreativeProject, requireCreativeRevision, withCreativeMutation, hasRunningCreativeTask,
  linkCreativeShotTask, createCreativeRender, validateCreativeMedia, publicCreativeMediaUrl } from './creative-projects.js'
export const productionDependencies = { generateImage, generateVideo, renderCreativeVideo }
export type ProductionDependencies = typeof productionDependencies
export async function generateCreativeShot(id: number, shotId: string, input: {revision:number;kind:'image'|'video';configId?:number}, deps: ProductionDependencies = productionDependencies) {
  return withCreativeMutation(id, async () => {
      const project = requireCreativeRevision(id, input.revision, true)
      const shot = project.shots.find(shot => shot.id === shotId)
      if (!shot) throw new CreativeError('镜头不存在', 404)
      if (hasRunningCreativeTask(id, shot.id, input.kind)) return getCreativeProject(id)
      if (!shot.visualPrompt.trim()) throw new CreativeError('请先填写并保存画面描述')
      if (input.configId) {
        const config = db.select().from(schema.aiServiceConfigs).where(eq(schema.aiServiceConfigs.id, input.configId)).get()
        if (config?.serviceType !== input.kind || !(await getConfigById(input.configId, input.kind))) throw new CreativeError('所选模型配置已停用或与生成类型不匹配')
      }
      const preset = db.select().from(schema.stylePresets).where(eq(schema.stylePresets.value, project.style)).get()
      const prompt = [preset?.prompt, shot.visualPrompt].filter(Boolean).join('\n\n')
      const sizes = { '16:9': '1536x864', '9:16': '864x1536', '1:1': '1024x1024' }
      if (shot.imageUrl) validateCreativeMedia(id, shot.imageUrl, 'image')
      let generationDuration = Math.ceil(shot.duration)
      if (input.kind === 'video') {
        if (shot.duration > 15) throw new CreativeError('生成视频单镜头最多 15 秒，请先拆分镜头；原片剪辑不受此限制')
        const config = input.configId ? await getConfigById(input.configId, input.kind) : await getActiveConfig('video')
        if (!config) throw new CreativeError('未配置视频模型，请先在设置中心添加并启用视频服务')
        if (['minimax', 'volcengine'].includes(config.provider) && shot.duration > 15) {
          throw new CreativeError('当前视频模型单次最多生成 15 秒，请缩短或拆分这个镜头')
        }
        generationDuration = Math.max(config.provider === 'aliyun' ? 2 : 4, generationDuration)
      }
      const taskId = input.kind === 'image'
        ? await deps.generateImage({ dramaId: id, prompt, size: sizes[project.aspectRatio], configId: input.configId })
        : await deps.generateVideo({
          dramaId: id, prompt, duration: generationDuration, aspectRatio: project.aspectRatio,
          configId: input.configId, referenceMode: shot.imageUrl ? 'first_frame' : 'reference',
          firstFrameUrl: shot.imageUrl || undefined, generateAudio: true, resolution: '720p',
        })
      linkCreativeShotTask(project, shot, input.kind, taskId)
      return getCreativeProject(id)
    })
}

export async function startCreativeRender(id: number, input: {revision:number;shotIds?:string[];individual?:boolean}, deps: ProductionDependencies = productionDependencies) {
  const {revision,shotIds,individual} = input
  return withCreativeMutation(id, () => {
      const project = requireCreativeRevision(id, revision, true)
      const chosen = shotIds ? project.shots.filter(shot => shotIds.includes(shot.id)) : project.shots
      if (shotIds && (chosen.length !== shotIds.length || new Set(shotIds).size !== shotIds.length)) throw new CreativeError('导出镜头不存在或重复')
      if (individual && project.audio.narrationUrl) throw new CreativeError('逐条导出不能使用整片旁白，请使用片段原声或移除整片旁白')
      if (!chosen.length) throw new CreativeError('请先添加镜头')
      if (hasRunningCreativeTask(id)) throw new CreativeError('镜头仍在生成，请完成后再导出', 409)
      for (const shot of chosen) {
        const media = shot.mediaType === 'image' ? shot.imageUrl : shot.videoUrl
        if (!media) throw new CreativeError(`镜头「${shot.title || shot.id}」缺少${shot.mediaType === 'image' ? '图片' : '视频'}素材`)
        validateCreativeMedia(id, media, shot.mediaType)
      }
      validateCreativeMedia(id, project.audio.narrationUrl, 'audio')
      validateCreativeMedia(id, project.audio.musicUrl, 'audio')
      const snapshot = {
        projectId: id, aspectRatio: project.aspectRatio, title: project.title,
        shots: chosen.map(shot => ({
          id: shot.id, title: shot.title, duration: shot.duration, mediaType: shot.mediaType,
          imageUrl: shot.imageUrl || undefined, videoUrl: shot.videoUrl || undefined,
          audioUrl: shot.audioUrl, audioTrimStart: shot.audioTrimStart, caption: shot.caption, trimStart: shot.trimStart, originalVolume: shot.originalVolume,
        })),
        narrationUrl: project.audio.narrationUrl || undefined, musicUrl: project.audio.musicUrl || undefined,
        musicVolume: project.audio.musicVolume, burnSubtitles: project.audio.burnSubtitles,
      }
      for (const shot of chosen) validateCreativeMedia(id, shot.audioUrl ?? null, 'audio')
      const job = createCreativeRender(project, { ...snapshot, individual })
      if (job.created) {
        void (async () => {
          try {
            db.update(schema.creativeRenders).set({ status: 'processing', progress: 1 }).where(eq(schema.creativeRenders.id, job.id)).run()
            const outputs: { shotId: string; title: string; videoUrl: string; subtitleUrl: string | null; duration: number }[] = []
            const units = individual ? snapshot.shots.map(shot => [shot]) : [snapshot.shots]
            const results = []
            for (const [index, shots] of units.entries()) {
              const result = await deps.renderCreativeVideo({ ...snapshot, shots }, progress => {
                db.update(schema.creativeRenders).set({ progress: Math.max(1, Math.min(99, Math.floor((index * 100 + progress) / units.length))) }).where(eq(schema.creativeRenders.id, job.id)).run()
              })
              results.push(result)
              if (individual) {
                outputs.push({ shotId: shots[0].id, title: shots[0].title, videoUrl: publicCreativeMediaUrl(result.videoUrl), subtitleUrl: result.subtitleUrl ? publicCreativeMediaUrl(result.subtitleUrl) : null, duration: result.duration })
                db.update(schema.creativeRenders).set({ outputs: JSON.stringify(outputs) }).where(eq(schema.creativeRenders.id, job.id)).run()
              }
            }
            const result = { ...results[0], duration: results.reduce((sum, item) => sum + item.duration, 0), warnings: results.flatMap(item => item.warnings) }
            const warnings = [...result.warnings]
            if (project.shots.some(shot => shot.narration.trim()) && !snapshot.narrationUrl) warnings.push('方案含旁白文案，本次未添加独立旁白音轨')
            db.update(schema.creativeRenders).set({ status: 'completed', progress: 100,
              outputs: JSON.stringify(outputs), videoUrl: individual ? null : publicCreativeMediaUrl(result.videoUrl), subtitleUrl: !individual && result.subtitleUrl ? publicCreativeMediaUrl(result.subtitleUrl) : null,
              duration: result.duration, warnings: JSON.stringify(warnings), completedAt: now(),
            }).where(eq(schema.creativeRenders.id, job.id)).run()
            const fresh = db.select().from(schema.creativeProjects).where(eq(schema.creativeProjects.projectId, id)).get()
            if (fresh?.revision === revision) db.update(schema.dramas).set({ status: 'completed', totalDuration: Math.round(result.duration), updatedAt: now() }).where(eq(schema.dramas.id, id)).run()
          } catch (error) {
            db.update(schema.creativeRenders).set({ status: 'failed', errorMsg: error instanceof Error ? error.message.slice(0, 1000) : '导出失败，请重试', completedAt: now() }).where(eq(schema.creativeRenders.id, job.id)).run()
          }
        })()
      }
      return getCreativeProject(id)
  })
}
