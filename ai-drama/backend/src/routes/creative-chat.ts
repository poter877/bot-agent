import { Hono } from 'hono'
import { z } from 'zod'
import { success } from '../utils/response.js'
import { revisionSchema } from '../services/creative-model.js'
import { chatWithCreativeProject, listCreativeMessages } from '../services/creative-chat.js'

export const creativeChatRoutes = new Hono()
creativeChatRoutes.get('/:id/messages', c => success(c, listCreativeMessages(Number(c.req.param('id')))))
creativeChatRoutes.post('/:id/chat', async c => {
  const { revision, message } = z.object({ revision: revisionSchema, message: z.string().trim().min(1).max(8000) }).parse(await c.req.json())
  return success(c, await chatWithCreativeProject(Number(c.req.param('id')), revision, message))
})
