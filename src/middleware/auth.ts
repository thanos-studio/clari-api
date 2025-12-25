import { Context, Next } from 'hono'
import { verifyToken } from '../utils/jwt'

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
  c.set('userId', payload.userId)
  await next()
}
