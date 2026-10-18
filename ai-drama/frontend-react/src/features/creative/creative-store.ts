import { createStore } from 'zustand'

export type CreativeStage = 'toolbox' | 'tools' | 'pipeline' | 'brief' | 'shots' | 'audio' | 'export'

export const createCreativeStore = () => createStore<{
  stage: CreativeStage
  selectedShotId: string | null
  setStage: (stage: CreativeStage) => void
  selectShot: (id: string | null) => void
}>()((set) => ({
  stage: 'pipeline',
  selectedShotId: null,
  setStage: (stage) => set({ stage }),
  selectShot: (selectedShotId) => set({ selectedShotId }),
}))
