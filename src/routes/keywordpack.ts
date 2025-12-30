import { Hono } from 'hono'
import prisma from '../db'
import { authMiddleware } from '../middleware/auth'
import OpenAI from 'openai'

type Variables = {
  userId: string
}

const keywordPackRouter = new Hono<{ Variables: Variables }>()

keywordPackRouter.use('*', authMiddleware)

const azureOpenAI = new OpenAI({
  apiKey: process.env.AZURE_API_KEY,
  baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
  defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_API_KEY },
})

keywordPackRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const limit = parseInt(c.req.query('limit') || '50')

  const packs = await prisma.keywordPack.findMany({
    where: { authorId: userId },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: {
      id: true,
      name: true,
      keywords: true,
      createdAt: true,
      updatedAt: true,
      isPublic: true,
      previewImageUrl: true,
    },
  })

  return c.json({ packs })
})

keywordPackRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const packId = c.req.param('id')

  const pack = await prisma.keywordPack.findUnique({
    where: { id: packId },
  })

  if (!pack) {
    return c.json({ error: 'Keyword pack not found' }, 404)
  }

  if (!pack.isPublic && pack.authorId !== userId) {
    return c.json({ error: 'Access denied' }, 403)
  }

  return c.json({ pack })
})

keywordPackRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const { name, keywords, isPublic } = await c.req.json()

  if (!name) {
    return c.json({ error: 'Name is required' }, 400)
  }

  const pack = await prisma.keywordPack.create({
    data: {
      name,
      keywords: keywords || [],
      isPublic: isPublic || false,
      authorId: userId,
    },
  })

  return c.json({ pack })
})

keywordPackRouter.post('/:id/keywords', async (c) => {
  const userId = c.get('userId')
  const packId = c.req.param('id')
  const { name, description } = await c.req.json()

  if (!name) {
    return c.json({ error: 'Keyword name is required' }, 400)
  }

  const pack = await prisma.keywordPack.findFirst({
    where: {
      id: packId,
      authorId: userId,
    },
  })

  if (!pack) {
    return c.json({ error: 'Keyword pack not found' }, 404)
  }

  const keywords = Array.isArray(pack.keywords) ? pack.keywords : []
  keywords.push({ name, description: description || '' })

  const updatedPack = await prisma.keywordPack.update({
    where: { id: packId },
    data: { keywords },
  })

  return c.json({ pack: updatedPack })
})

keywordPackRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const packId = c.req.param('id')
  const { name, keywords, isPublic, previewImageUrl } = await c.req.json()

  const pack = await prisma.keywordPack.findFirst({
    where: {
      id: packId,
      authorId: userId,
    },
  })

  if (!pack) {
    return c.json({ error: 'Keyword pack not found' }, 404)
  }

  const updateData: any = {}
  if (name !== undefined) updateData.name = name
  if (keywords !== undefined) updateData.keywords = keywords
  if (isPublic !== undefined) updateData.isPublic = isPublic
  if (previewImageUrl !== undefined) updateData.previewImageUrl = previewImageUrl

  const updatedPack = await prisma.keywordPack.update({
    where: { id: packId },
    data: updateData,
  })

  return c.json({ pack: updatedPack })
})

keywordPackRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const packId = c.req.param('id')

  const pack = await prisma.keywordPack.findFirst({
    where: {
      id: packId,
      authorId: userId,
    },
  })

  if (!pack) {
    return c.json({ error: 'Keyword pack not found' }, 404)
  }

  await prisma.keywordPack.delete({
    where: { id: packId },
  })

  return c.json({ message: 'Keyword pack deleted successfully' })
})

keywordPackRouter.post('/ai/autocomplete', async (c) => {
  const { name } = await c.req.json()

  if (!name) {
    return c.json({ error: 'Keyword name is required' }, 400)
  }

  try {
    const response = await azureOpenAI.chat.completions.create({
      model: process.env.AZURE_DEPLOYMENT_NAME!,
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that provides 5 different brief Korean descriptions for technical terms and keywords. Each description should be one concise sentence.',
        },
        {
          role: 'user',
          content: `단어: "${name}"\n\n이 단어에 대한 5가지 다른 한줄 설명을 제공해주세요. 각 설명은 한 문장으로 간결하게 작성하고, JSON 배열 형식으로 반환해주세요: ["설명1", "설명2", "설명3", "설명4", "설명5"]`,
        },
      ],
      temperature: 0.7,
      max_tokens: 500,
    })

    const content = response.choices[0].message.content || '[]'
    let suggestions: string[]

    try {
      suggestions = JSON.parse(content)
    } catch {
      const lines = content.split('\n').filter((l) => l.trim())
      suggestions = lines.slice(0, 5)
    }

    return c.json({ suggestions })
  } catch (error) {
    console.error('AI autocomplete error:', error)
    return c.json({ error: 'Failed to generate suggestions' }, 500)
  }
})

keywordPackRouter.post('/ai/autofill', async (c) => {
  const { query, count } = await c.req.json()

  if (!query) {
    return c.json({ error: 'Query is required' }, 400)
  }

  const keywordCount = count || 50

  try {
    console.log(`🚀 [AUTOFILL] Starting: ${query} (${keywordCount} keywords)`)
    
    // Step 1: Fast Perplexity search with optimized settings
    console.log(`🔍 [AUTOFILL] Step 1/3: Searching with Perplexity...`)
    const perplexityStart = Date.now()
    
    const perplexityResponse = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar', // Fast model
        messages: [
          {
            role: 'user',
            content: `List ${Math.min(keywordCount + 10, 60)} technical terms related to: ${query}. Include brief definitions.`,
          },
        ],
        max_tokens: 2000, // Reduced for speed
        temperature: 0.3, // Lower for consistency
      }),
    })

    if (!perplexityResponse.ok) {
      throw new Error('Perplexity API request failed')
    }

    const perplexityData = await perplexityResponse.json()
    const searchResult = perplexityData.choices[0].message.content
    
    const perplexityTime = Date.now() - perplexityStart
    console.log(`✅ [AUTOFILL] Step 1 complete (${perplexityTime}ms)`)

    // Step 2: Quick GPT extraction
    console.log(`🤖 [AUTOFILL] Step 2/3: Extracting keywords with GPT...`)
    const gptStart = Date.now()
    
    const response = await azureOpenAI.chat.completions.create({
      model: process.env.AZURE_DEPLOYMENT_NAME!,
      messages: [
        {
          role: 'system',
          content: `Extract exactly ${keywordCount} technical terms with Korean descriptions. Return ONLY valid JSON array.`,
        },
        {
          role: 'user',
          content: `Extract ${keywordCount} terms:\n\n${searchResult}\n\nJSON format: [{"name":"term","description":"Korean desc"}]`,
        },
      ],
      temperature: 0.2,
      max_tokens: Math.min(keywordCount * 50, 4000), // Dynamic based on count
    })

    const content = response.choices[0].message.content || '[]'
    let keywords: Array<{ name: string; description: string }>

    try {
      keywords = JSON.parse(content)
    } catch {
      keywords = []
    }

    const gptTime = Date.now() - gptStart
    console.log(`✅ [AUTOFILL] Step 2 complete (${gptTime}ms)`)

    // Step 3: Generate Korean pronunciations for English terms
    console.log(`🔤 [AUTOFILL] Step 3/3: Generating Korean pronunciations...`)
    const pronunciationStart = Date.now()
    
    const englishTerms = keywords.filter(k => /^[a-zA-Z0-9\s\-_]+$/.test(k.name))
    
    if (englishTerms.length > 0) {
      const pronunciationResponse = await azureOpenAI.chat.completions.create({
        model: process.env.AZURE_DEPLOYMENT_NAME!,
        messages: [
          {
            role: 'system',
            content: `You are a Korean pronunciation generator. For each English term, provide how it sounds in Korean (Hangul). Return ONLY valid JSON.`,
          },
          {
            role: 'user',
            content: `Generate Korean pronunciations for these terms:\n${englishTerms.map(k => k.name).join(', ')}\n\nJSON format: [{"term":"API","pronunciation":"에이피아이"},{"term":"React","pronunciation":"리액트"}]`,
          },
        ],
        temperature: 0.1,
        max_tokens: Math.min(englishTerms.length * 30, 2000),
      })

      const pronunciationContent = pronunciationResponse.choices[0].message.content || '[]'
      let pronunciations: Array<{ term: string; pronunciation: string }> = []

      try {
        pronunciations = JSON.parse(pronunciationContent)
      } catch {
        console.warn('⚠️ [AUTOFILL] Failed to parse pronunciations')
      }

      // Merge pronunciations into keywords
      const pronunciationMap = new Map(pronunciations.map(p => [p.term, p.pronunciation]))
      keywords = keywords.map(k => ({
        ...k,
        koreanPronunciation: pronunciationMap.get(k.name) || undefined
      }))
    }

    const pronunciationTime = Date.now() - pronunciationStart
    const totalTime = perplexityTime + gptTime + pronunciationTime
    
    console.log(`✅ [AUTOFILL] Step 3 complete (${pronunciationTime}ms)`)
    console.log(`🎉 [AUTOFILL] Total: ${keywords.length} keywords in ${totalTime}ms`)

    return c.json({ 
      keywords,
      stats: {
        perplexityTime,
        gptTime,
        pronunciationTime,
        totalTime,
        requestedCount: keywordCount,
        actualCount: keywords.length,
        withPronunciation: keywords.filter(k => k.koreanPronunciation).length
      }
    })
  } catch (error) {
    console.error('❌ [AUTOFILL] Error:', error)
    return c.json({ error: 'Failed to generate keywords' }, 500)
  }
})

export default keywordPackRouter
