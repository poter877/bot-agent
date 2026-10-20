/**
 * 当前启用配置行的唯一选择规则 — 与后端 resolveServiceRow/rankConfigs 完全一致：
 * isActive 过滤 → priority 降序 → id 升序。
 *
 * 面板（设置→AI 配置）、工作台模型下拉、后端执行管道三处必须落在同一行上；
 * 规则分叉时"面板里设置的模型"与"管道实际使用的模型"会指向不同配置行
 * （曾因重复建档暴露：面板读新行、管道读旧行，默认模型永远传不下去）。
 */
import type { AiConfig } from '@/entities/ai-config/model'

export function pickActiveConfig(cfgs: AiConfig[]): AiConfig | null {
  const active = cfgs
    .filter(c => c.isActive)
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.id - b.id)

  return active[0] ?? null
}
