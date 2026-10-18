/** StudioLayout — 工作台全屏壳（100vh、overflow hidden），episode 路由专用 */
import { Outlet } from 'react-router'

export function StudioLayout() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-app">
      <Outlet />
    </div>
  )
}
