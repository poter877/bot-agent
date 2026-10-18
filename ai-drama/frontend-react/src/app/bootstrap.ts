/**
 * 应用引导：i18n 初始化、tokens/tour 主题样式、启动时预取引导标记。
 * React 挂载前显式完成应用初始化。
 */
import { hydrateTours } from '@/shared/lib/tour'

// 顺序敏感：i18n 先于 React 渲染（首帧即有文案）；tour 水合 fire-and-forget
export function bootstrap() {
  void hydrateTours()
}
