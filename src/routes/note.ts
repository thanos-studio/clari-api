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


  const note = await prisma.note.findUnique({
    where: { id: noteId },
  })

  if (!note) {
    return c.json({ error: 'Note not found' }, 404)
  }

  if (!note.isPublic && note.authorId !== userId) {
    return c.json({ error: 'Access denied' }, 403)
  }


  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, name: true },
  })

  if (!user) {
    return c.json({ error: 'User not found' }, 404)
  }


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

  const roleContext = user.role 
    ? `This user has the role "${user.role}". Please adjust the explanation level accordingly.`
    : 'Please provide explanations for a general user.'

  const systemPrompt = `You are an AI tutor that explains learning content.

When a user requests an explanation for a specific sentence:
1. Understand the context of the entire conversation/lecture
2. Explain what meaning this sentence has within the overall content
3. Explain key concepts or terms in an easy-to-understand way
4. Provide examples when necessary to aid understanding

${roleContext}

Provide explanations in the following format:
- **Context**: Where this sentence fits in the overall content
- **Core Explanation**: Explanation of main concepts or content
- **Supplementary Information**: Additional helpful information (when needed)

Please explain concisely and clearly.`

  const userPrompt = `Full conversation content:
"""
${formattedTranscript}
"""

Sentence that needs explanation:
"${sentence}"

Please explain this sentence considering the context.`

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
