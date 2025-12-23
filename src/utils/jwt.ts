import {sign, verify} from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production'

export function generateToken(userId: string): string {
  return sign({ userId }, JWT_SECRET, { expiresIn: '30d' })
}

export function verifyToken(token: string): { userId: string } | null {
  try {
    return verify(token, JWT_SECRET) as { userId: string }
  } catch {
    return null
  }
}
