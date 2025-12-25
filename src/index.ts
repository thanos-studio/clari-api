import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { upgradeWebSocket, websocket } from 'hono/bun'
import authRouter from './routes/auth'
import noteRouter from './routes/note'
import { createSttWebSocketHandler } from './routes/stt'
import createRecordingWebSocketHandler from './routes/recording'
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

const sttRouter = createSttWebSocketHandler(upgradeWebSocket)
app.route('/ws/stt', sttRouter)

const recordingRouter = createRecordingWebSocketHandler(upgradeWebSocket)
app.route('/notes', recordingRouter)

app.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId')
  
  console.log(`👤 [ME] Fetching user info for: ${userId}`)
  
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
    console.log(`❌ [ME] User not found: ${userId}`)
    return c.json({ error: 'User not found' }, 404)
  }

  console.log(`✅ [ME] User found: ${user.email}`)

  return c.json({ user })
})

export default {
    port: 3000,
    fetch: app.fetch,
    websocket,
}