// The video-studio page mounts the ai-drama frontend from OUTSIDE this
// workspace (../../ai-drama/frontend-react/src). Vite compiles those sources
// through the `hermes:drama-source` resolver in vite.config.ts; tsc does not
// typecheck that tree, so the embed surface is declared here instead — the
// ambient-module pattern vite-env.d.ts already uses (@novnc/novnc).
//
// Keep this file script-scoped (top-level imports would make it a module and
// silently disable `declare module`).

declare module '@drama/embed' {
  import type { ComponentType } from 'react'

  export const DramaApp: ComponentType<{ initialPath?: string }>
}

declare module '@drama/app/styles/index.css' {
  // Drama's stylesheet is compiled by the app's Tailwind v4 setup; the import
  // is for side effects only.
}
