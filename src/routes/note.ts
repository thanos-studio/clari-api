import { Hono } from 'hono'
import prisma from '../db'
import { authMiddleware } from '../middleware/auth'
import { AzureOpenAI } from 'openai'

type Variables = {
  userId: string
}

const noteRouter = new Hono<{ Variables: Variables }>()

const azureClient = new AzureOpenAI({
  apiVersion: process.env.AZURE_API_VERSION ?? "2023-07-01-preview",
  endpoint: process.env.AZURE_ENDPOINT,
  apiKey: process.env.AZURE_API_KEY,
})

const AZURE_DEPLOYMENT = process.env.AZURE_DEPLOYMENT_NAME ?? "gpt-4"

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

noteRouter.post('/:id/ai/explanation', async (c) => {
  const userId = c.get('userId')
  const noteId = c.req.param('id')
  const { sentence } = await c.req.json<{ sentence: string }>()

  if (!sentence || !sentence.trim()) {
    return c.json({ error: 'sentence is required' }, 400)
  }

  console.log(`🤖 [AI-EXPLANATION] Request for note: ${noteId}`)
  console.log(`   Sentence: "${sentence}"`)

  // Get note
  const note = await prisma.note.findUnique({
    where: { id: noteId },
  })

  if (!note) {
    return c.json({ error: 'Note not found' }, 404)
  }

  if (!note.isPublic && note.authorId !== userId) {
    return c.json({ error: 'Access denied' }, 403)
  }

  // Get user role
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, name: true },
  })

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }

  // Extract full transcript from note content
  let fullTranscript = ''
  let formattedTranscript = ''
  
  try {
    const content = note.content ? JSON.parse(note.content) : {}
    fullTranscript = content.text || ''
    formattedTranscript = content.formatted_text || fullTranscript
  } catch (e) {
    console.error('⚠️ [AI-EXPLANATION] Failed to parse note content')
    fullTranscript = note.content || ''
  }

  console.log(`   User role: ${user.role || '(none)'}`)
  console.log(`   Transcript length: ${fullTranscript.length} chars`)

  // Build context-aware prompt
  const roleContext = user.role 
    ? `이 사용자는 "${user.role}" 역할입니다. 이에 맞춰 설명 수준을 조정해주세요.`
    : '일반 사용자를 위한 설명을 제공해주세요.'

  const systemPrompt = `당신은 학습 내용을 설명하는 AI 튜터입니다.

사용자가 특정 문장에 대한 설명을 요청하면:
1. 전체 대화/강의 맥락을 파악합니다
2. 해당 문장이 전체 내용에서 어떤 의미를 가지는지 설명합니다
3. 핵심 개념이나 용어를 쉽게 풀이합니다
4. 필요시 예시를 들어 이해를 돕습니다

${roleContext}

설명은 다음 형식으로 제공:
- **맥락**: 이 문장이 전체 내용에서 어떤 부분인지
- **핵심 설명**: 주요 개념이나 내용 설명
- **보충 설명**: 추가로 알아두면 좋은 내용 (필요시)

간결하고 명확하게 설명해주세요.`

  const userPrompt = `전체 대화 내용:
"""
${formattedTranscript}
"""

설명이 필요한 문장:
"${sentence}"

위 문장에 대해 맥락을 고려하여 설명해주세요.`

  try {
    console.log(`🤖 [AI-EXPLANATION] Calling GPT...`)
    const startTime = Date.now()

    const response = await azureClient.chat.completions.create({
      model: AZURE_DEPLOYMENT,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 1000,
    })

    const explanation = response.choices[0]?.message?.content?.trim() || ''
    const elapsedTime = Date.now() - startTime

    console.log(`✅ [AI-EXPLANATION] Generated in ${elapsedTime}ms`)
    console.log(`   Length: ${explanation.length} chars`)

    return c.json({
      sentence,
      explanation,
      context: {
        userRole: user.role,
        noteTitle: note.title,
        transcriptLength: fullTranscript.length,
      },
      generatedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('❌ [AI-EXPLANATION] Error:', error)
    return c.json({ error: 'Failed to generate explanation' }, 500)
  }
})

export default noteRouter
