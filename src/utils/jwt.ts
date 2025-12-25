import {sign, verify} from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'

console.log(`🔐 [JWT] Secret loaded: ${JWT_SECRET}`)

export function generateToken(userId: string): string {
  const token = sign({ userId }, JWT_SECRET, { expiresIn: '30d' })
  console.log(`✅ [JWT] Generated token for user: ${userId}`)
  console.log(`🔑 [JWT] Full token: ${token}`)
  return token
}

export function verifyToken(token: string): { userId: string } | null {
  try {
    const payload = verify(token, JWT_SECRET) as { userId: string }
    console.log(`✅ [JWT] Token verified for user: ${payload.userId}`)
    return payload
  } catch (e: any) {
    console.log(`❌ [JWT] Token verification failed: ${e.message}`)
    console.log(`❌ [JWT] Failed token: ${token}`)
    return null
  }
}
