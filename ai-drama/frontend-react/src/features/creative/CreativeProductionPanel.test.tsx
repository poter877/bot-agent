// @vitest-environment jsdom
import { pipelineApi } from '@/entities/creative/pipeline'
import { toolboxApi } from '@/entities/creative/toolbox'
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { creativeApi } from '@/entities/creative/api'
import { toCreativeDraft, type CreativeProject } from '@/entities/creative/model'
import { initI18n } from '@/shared/config/i18n'
import { publicCreativeCatalog } from '../../../../backend/src/services/creative-catalog'
import { CreativeProductionPanel } from './CreativeProductionPanel'

const project: CreativeProject = {
  id:9,title:'切片测试',category:'clip_factory',style:'3d',aspectRatio:'16:9',revision:3,approvedRevision:null,updatedAt:'',
  brief:{idea:'剪辑采访',audience:'',tone:'',targetDuration:60,language:'zh-CN'},plan:{summary:'',script:'',musicDirection:''},
  audio:{narrationUrl:null,musicUrl:null,musicVolume:0.2,burnSubtitles:false},shots:[],renders:[],
  production:{fields:{selection:'有完整结论的片段'},sources:[{id:'source-one',name:'采访.mp4',kind:'video',url:'/static/uploads/interview.mp4',duration:90,coverUrl:null,transcript:'原话',attribution:''}]},
}
const accepted = vi.fn(), busy = vi.fn()
function mount() {
  function Harness() {
    const [draft,setDraft] = useState(()=>toCreativeDraft(project))
    return <><CreativeProductionPanel project={project} draft={draft} recipe={publicCreativeCatalog().find(r=>r.id==='clip_factory')} disabled={false} canRun onChange={setDraft} onProjectUpdated={accepted} onBusyChange={busy}/><output data-testid="draft">{JSON.stringify(draft.production)}</output></>
  }
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{mutations:{retry:false}}})}><Harness/></QueryClientProvider>)
}
beforeEach(async()=>{vi.spyOn(pipelineApi,'toolPlan').mockResolvedValue({steps:[],policies:[]});vi.spyOn(toolboxApi,'catalog').mockResolvedValue({tools:[],providers:[]});await initI18n().changeLanguage('zh');accepted.mockReset();busy.mockReset()})
afterEach(()=>{cleanup();vi.restoreAllMocks()})
it('edits the category brief and original transcript without replacing source metadata',()=>{
  mount()
  fireEvent.change(screen.getByLabelText('选段标准'),{target:{value:'保留技术细节'}})
  fireEvent.change(screen.getByLabelText(/素材说明/),{target:{value:'00:10 原话'}})
  const state=JSON.parse(screen.getByTestId('draft').textContent!)
  expect(state.fields.selection).toBe('保留技术细节')
  expect(state.sources[0]).toEqual({...project.production!.sources[0],transcript:'00:10 原话'})
})
it('queues real source ranges and sends them together with the current revision',async()=>{
  const user=userEvent.setup()
  const arrange=vi.spyOn(creativeApi,'sourceArrange').mockResolvedValue(project)
  mount()
  fireEvent.change(screen.getByLabelText('原片起点（秒）'),{target:{value:'10'}})
  fireEvent.change(screen.getByLabelText('原片终点（秒）'),{target:{value:'20'}})
  await user.click(screen.getByRole('button',{name:'加入选段列表'}))
  fireEvent.change(screen.getByLabelText('原片起点（秒）'),{target:{value:'30'}})
  fireEvent.change(screen.getByLabelText('原片终点（秒）'),{target:{value:'40'}})
  await user.click(screen.getByRole('button',{name:'加入选段列表'}))
  await user.click(screen.getByRole('button',{name:'添加到画面编排'}))
  await waitFor(()=>expect(accepted).toHaveBeenCalledWith(project))
  expect(arrange).toHaveBeenCalledWith(9,{revision:3,sourceId:'source-one',selections:[{start:10,end:20,title:'采访.mp4',caption:''},{start:30,end:40,title:'采访.mp4',caption:''}]})
  expect(busy).toHaveBeenLastCalledWith(false)
})
it('disables invalid source ranges before sending a request',()=>{
  mount()
  fireEvent.change(screen.getByLabelText('原片终点（秒）'),{target:{value:'100'}})
  expect((screen.getByRole('button',{name:'添加到画面编排'}) as HTMLButtonElement).disabled).toBe(true)
})
