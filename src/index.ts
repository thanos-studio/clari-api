import { Hono } from 'hono'
import { cors } from 'hono/cors'
import authRouter from './routes/auth'
import noteRouter from './routes/note'
import { authMiddleware } from './middleware/auth'
import prisma from './db'

type Variables = {
  userId: string
}

const app = new Hono<{ Variables: Variables }>()

app.use('*', cors())

app.get('/', (c) => {
  return c.json({ message: 'Clari API Server' })
})

app.route('/auth', authRouter)
app.route('/notes', noteRouter)

app.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId')
  
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      profileUrl: true,
    },
  })

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  return c.json({ user })
})

export default {
    port: 80,
    fetch: app.fetch,
}