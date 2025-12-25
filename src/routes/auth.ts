import { Hono } from 'hono'
import { OAuth2Client } from 'google-auth-library'
import prisma from '../db'
import { generateToken } from '../utils/jwt'

const authRouter = new Hono()

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID)

authRouter.post('/google', async (c) => {
  try {
    const { idToken } = await c.req.json<{ idToken: string }>()

    console.log('🔐 [AUTH] Google OAuth request received')

    if (!idToken) {
      console.log('❌ [AUTH] Missing idToken')
      return c.json({ error: 'idToken is required' }, 400)
    }

    const ticket = await client.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    })

      console.log(ticket.getPayload(), ticket.getUserId())

    const payload = ticket.getPayload()
    
    if (!payload) {
      console.log('❌ [AUTH] Invalid Google token')
      return c.json({ error: 'Invalid token' }, 401)
    }

    const { sub: googleId, email, name, picture } = payload

    console.log(`✅ [AUTH] Google token verified for: ${email}`)

    if (!email) {
      console.log('❌ [AUTH] Email not provided')
      return c.json({ error: 'Email not provided by Google' }, 400)
    }

    let user = await prisma.user.findUnique({
      where: { googleId },
    })

    if (!user) {
      console.log(`📝 [AUTH] Creating/updating user: ${email}`)
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

    console.log(`✅ [AUTH] Login successful for user: ${user.id}`)

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
    console.error('❌ [AUTH] Google OAuth error:', error)
    return c.json({ error: 'Authentication failed' }, 500)
  }
})

export default authRouter
