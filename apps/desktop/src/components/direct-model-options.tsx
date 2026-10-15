import type { ModelOptionsResult } from '@hermes/shared'
import type { ReactNode } from 'react'

import { directModelOptionsAllowed } from '@/lib/model-options'

interface DirectModelOptionsProps {
  children: ReactNode
  options: ModelOptionsResult | undefined
}

/** Setup and custom-model controls apply only to a directory that permits direct providers. */
export function DirectModelOptions({ children, options }: DirectModelOptionsProps) {
  return directModelOptionsAllowed(options) ? children : null
}
