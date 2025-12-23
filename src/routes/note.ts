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

  const notes = await prisma.note.findMany({
    where: { authorId: userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      title: true,
      durationInSeconds: true,
      createdAt: true,
      updatedAt: true,
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
