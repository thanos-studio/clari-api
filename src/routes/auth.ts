import { Hono } from 'hono'
import { OAuth2Client } from 'google-auth-library'
import prisma from '../db'
import { generateToken } from '../utils/jwt'

const authRouter = new Hono()

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

authRouter.post('/google', async (c) => {
  try {
    const { idToken } = await c.req.json<{ idToken: string }>()

    if (!idToken) {
      return c.json({ error: 'idToken is required' }, 400)
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    })

    const payload = ticket.getPayload()
    
    if (!payload) {
      return c.json({ error: 'Invalid token' }, 401)
    }

    const { sub: googleId, email, name, picture } = payload

    if (!email) {
      return c.json({ error: 'Email not provided by Google' }, 400)
    }

    let user = await prisma.user.findUnique({
      where: { googleId },
    })

    if (!user) {
      user = await prisma.user.upsert({
        where: { email },
        create: {
          email,
          name,
          googleId,
          profileUrl: picture,
        },
        update: {
          googleId,
          name,
          profileUrl: picture,
        },
      })
    }

    const accessToken = generateToken(user.id)

    return c.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        profileUrl: user.profileUrl,
      },
    })
  } catch (error) {
    console.error('Google OAuth error:', error)
    return c.json({ error: 'Authentication failed' }, 500)
  }
})

export default authRouter
