import { Hono } from 'hono'
import prisma from '../db'
import { authMiddleware } from '../middleware/auth'

type Variables = {
  userId: string
}

const noteRouter = new Hono<{ Variables: Variables }>()

noteRouter.use('*', authMiddleware)

noteRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const limit = parseInt(c.req.query('limit') || '10')
  const sort = c.req.query('sort') || 'recent_used'

  let orderBy: any = { lastUpdated: 'desc' }
  if (sort === 'recent_created') {
    orderBy = { createdAt: 'desc' }
  }

  const notes = await prisma.note.findMany({
    where: { authorId: userId },
    orderBy,
    take: limit,
    select: {
      id: true,
      title: true,
      durationInSeconds: true,
      createdAt: true,
      updatedAt: true,
      lastUpdated: true,
    },
  })

  return c.json({ notes })
})

noteRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('id')

  const note = await prisma.note.findUnique({
    where: { id: noteId },
  })

  if (!note) {
    return c.json({ error: 'Note not found' }, 404)
  }

  if (!note.isPublic && note.authorId !== userId) {
    return c.json({ error: 'Access denied' }, 403)
  }

  return c.json({ note })
})

noteRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('id')
  const { title, speakers } = await c.req.json()

  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      authorId: userId,
    },
  })

  if (!note) {
    return c.json({ error: 'Note not found' }, 404)
  }

  const updateData: any = {
    lastUpdated: new Date(),
  }

  if (title !== undefined) {
    updateData.title = title
  }

  if (speakers !== undefined) {
    updateData.speakers = JSON.parse(JSON.stringify(speakers))
  }

  const updatedNote = await prisma.note.update({
    where: { id: noteId },
    data: updateData,
  })

  return c.json({ note: updatedNote })
})

noteRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('id')

  const note = await prisma.note.findFirst({
    where: {
      id: noteId,
      authorId: userId,
    },
  })

  if (!note) {
    return c.json({ error: 'Note not found' }, 404)
  }

  await prisma.note.delete({
    where: { id: noteId },
  })

  return c.json({ message: 'Note deleted successfully' })
})

export default noteRouter
