import { Context, Next } from 'hono'
import { verifyToken } from '../utils/jwt'
import prisma from '../db'

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization')
  
  console.log(`🔐 [AUTH] Request to: ${c.req.method} ${c.req.path}`)
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log(`❌ [AUTH] No Authorization header or invalid format`)
    console.log(`❌ [AUTH] Header: ${authHeader}`)
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authHeader.substring(7)
  console.log(`🔑 [AUTH] Full token: ${token}`)
  
  const payload = verifyToken(token)

  if (!payload) {
    console.log(`❌ [AUTH] Token verification failed`)
    return c.json({ error: 'Invalid token' }, 401)
  }

  console.log(`✅ [AUTH] Token valid for user: ${payload.userId}`)
  
  // Check if user is active (except for /auth/register/continue)
  if (!c.req.path.includes('/auth/register/continue')) {
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: { isActive: true }
    })

    if (!user) {
      console.log(`❌ [AUTH] User not found: ${payload.userId}`)
      return c.json({ error: 'User not found' }, 404)
    }

    if (!user.isActive) {
      console.log(`❌ [AUTH] User not active: ${payload.userId}`)
      return c.json({ error: 'Account not activated. Please complete registration.' }, 403)
    }
  }

  c.set('userId', payload.userId)
  await next()
}
