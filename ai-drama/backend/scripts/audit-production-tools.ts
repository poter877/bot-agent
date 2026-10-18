/** Refresh factual coverage without importing or executing the reference runtime. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import inventory from '../src/services/production-tools/inventory.json' with { type: 'json' }
import { LOCAL_TOOL_IDS } from '../src/services/production-tools/local.js'
import { providerToolSpecs } from '../src/services/production-tools/providers.js'
import { auxiliaryIds, acquisitionDomains } from '../src/services/production-tools/auxiliary.js'
import { sharedToolSpecs } from '../src/services/production-tools/catalog.js'
import { pipelineToolPolicies } from '../src/services/creative-pipeline/tool-policy.js'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tools = inventory.map((item) => {
  const kind = LOCAL_TOOL_IDS.includes(item.id)
    ? 'local'
    : providerToolSpecs[item.id]
      ? 'provider-adapter'
      : auxiliaryIds.includes(item.id)
        ? 'source-or-analysis'
        : 'unified-service'
  const spec = providerToolSpecs[item.id] ?? sharedToolSpecs[item.id]
  const implemented = kind === 'local' || !!spec || auxiliaryIds.includes(item.id)
  const notes: string[] = []
  if (acquisitionDomains[item.id])
    notes.push(
      'Returns attributed source pages via Tavily. Download and license review happen at the source page; no scraped direct-download link is invented.',
    )
  if (item.id === 'sora_video')
    notes.push(
      'Original Videos API shut down 2026-09-24. Uses a supported configured video model instead of calling a retired API.',
    )
  if (item.id === 'google_imagen')
    notes.push('Imagen migrated to the supported Gemini Nano Banana image API.')
  if (['gemini_omni_video', 'kling_tts', 'ltx_video_modal', 'minimax_image'].includes(item.id))
    notes.push(
      'Equivalent capability uses the configured shared service; not a direct connection to the original provider/deployment.',
    )
  if (spec?.provider === 'comfyui')
    notes.push(
      'Requires a deployed ComfyUI instance, matching model/custom nodes and a user-supplied API workflow. No weights or custom-node installers are bundled.',
    )
  if (item.id === 'hyperframes_compose')
    notes.push(
      'Structured native FFmpeg composition; does not execute external Hyperframes application code.',
    )
  if (item.id === 'math_animate')
    notes.push('Structured graph/formula animation; does not run arbitrary Python/Manim source.')
  if (item.id === 'kling_avatar' || item.id === 'kling_lip_sync')
    notes.push('Uses unified Sync character/lip-sync service; actual provider is shown in the catalog.')
  return {
    ...item,
    implemented,
    executionFamily: kind,
    actualProvider:
      spec?.provider ??
      (acquisitionDomains[item.id] ? 'tavily' : kind === 'local' ? 'local' : item.referenceProvider),
    serviceType: spec?.serviceType,
    notes,
    pipeline: pipelineToolPolicies[item.id],
  }
})
if (tools.some((tool) => !tool.implemented)) throw new Error('Inventory has unmapped tools')
const counts = Object.fromEntries(
  [...new Set(tools.map((tool) => tool.executionFamily))].map((family) => [
    family,
    tools.filter((tool) => tool.executionFamily === family).length,
  ]),
)
const audit = {
  reference: 'calesthio/OpenMontage local checkout',
  referencePythonFiles: 190,
  uniqueNamedToolsAndSources: tools.length,
  executionCounts: counts,
  pipelineCoverage: {
    matched: tools.filter((tool) => !!tool.pipeline).length,
    unmapped: tools.filter((tool) => !tool.pipeline).map((tool) => tool.id),
    meaning:
      'Eligible workflow stages and selection conditions. Alternative models are selected by need; not every tool is run in every video.',
  },
  verification:
    'Native media and provider contract/recovery suites are run separately. Cloud endpoints require credentials; no paid live generation is claimed by this inventory.',
  sources: [
    'https://developers.openai.com/api/docs/deprecations',
    'https://ai.google.dev/gemini-api/docs/imagen',
  ],
  tools,
}
await fs.writeFile(
  path.join(root, 'backend/docs/production-tool-coverage.json'),
  JSON.stringify(audit, null, 2) + '\n',
)
console.log(
  JSON.stringify({ tools: tools.length, counts, unmapped: tools.filter((tool) => !tool.implemented).length }),
)
