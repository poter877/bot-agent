import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { listCreativeMessages } from '../services/creative-chat.js'

export const creativeChatRoutes = new Hono()
creativeChatRoutes.get('/:id/messages', async c => success(c, await listCreativeMessages(Number(c.req.param('id')))))
