import { useParams } from 'react-router'
import { CreativeWorkbenchPage } from '@/features/creative/CreativeWorkbenchPage'

export default function CreativeRoute() {
  const { id } = useParams()
  return <CreativeWorkbenchPage key={id} projectId={Number(id)} />
}
