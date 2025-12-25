import { Hono } from 'hono'
import prisma from '../db'
import { authMiddleware } from '../middleware/auth'
import FirecrawlApp from '@mendable/firecrawl-js'
import OpenAI from 'openai'

type Variables = {
  userId: string
}

const externalResourceRouter = new Hono<{ Variables: Variables }>()

externalResourceRouter.use('*', authMiddleware)

const firecrawl = new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })

const azureOpenAI = new OpenAI({
  apiKey: process.env.AZURE_API_KEY,
  baseURL: `${process.env.AZURE_ENDPOINT}/openai/deployments/${process.env.AZURE_DEPLOYMENT_NAME}`,
  defaultQuery: { 'api-version': process.env.AZURE_API_VERSION },
  defaultHeaders: { 'api-key': process.env.AZURE_API_KEY },
})

function extractDisplayUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    return `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`
  } catch {
    return url
  }
}

async function generateShortTitle(content: string): Promise<string> {
  try {
    const response = await azureOpenAI.chat.completions.create({
      model: process.env.AZURE_DEPLOYMENT_NAME!,
      messages: [
        {
          role: 'system',
          content: '웹사이트 내용을 보고 10자 이하의 짧은 제목을 생성하세요. 제목만 반환하세요.',
        },
        {
          role: 'user',
          content: `다음 내용에 대한 10자 이하의 제목을 만들어주세요:\n\n${content.substring(0, 1000)}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 50,
    })
    return response.choices[0].message.content?.trim().substring(0, 10) || '외부 자료'
  } catch {
    return '외부 자료'
  }
}

// GET: List all external resources for the user
externalResourceRouter.get('/', async (c) => {
  const userId = c.get('userId')
  const limit = parseInt(c.req.query('limit') || '50')

  const resources = await prisma.externalResource.findMany({
    where: { authorId: userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      url: true,
      displayUrl: true,
      title: true,
      logoUrl: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return c.json({ resources })
})

// GET: Get a specific external resource
externalResourceRouter.get('/:id', async (c) => {
  const userId = c.get('userId')
  const resourceId = c.req.param('id')

  const resource = await prisma.externalResource.findUnique({
    where: { id: resourceId },
  })

  if (!resource) {
    return c.json({ error: 'External resource not found' }, 404)
  }

  if (resource.authorId !== userId) {
    return c.json({ error: 'Access denied' }, 403)
  }

  return c.json({ resource })
})

// POST: Create a new external resource with Firecrawl scraping
externalResourceRouter.post('/', async (c) => {
  const userId = c.get('userId')
  const { url } = await c.req.json()

  if (!url) {
    return c.json({ error: 'URL is required' }, 400)
  }

  try {
    // Scrape website with Firecrawl
    console.log(`🔥 [FIRECRAWL] Scraping: ${url}`)
    const scrapeResult = await firecrawl.scrapeUrl(url, {
      formats: ['markdown', 'html'],
    })

    if (!scrapeResult.success) {
      throw new Error('Failed to scrape URL')
    }

    const displayUrl = extractDisplayUrl(url)
    const scrapedContent = scrapeResult.markdown || scrapeResult.html || ''
    
    // Generate short title with GPT
    const title = await generateShortTitle(scrapedContent)

    // Extract logo from metadata
    const metadata = scrapeResult.metadata || {}
    const logoUrl = metadata.ogImage || metadata.favicon || null

    const resource = await prisma.externalResource.create({
      data: {
        url,
        displayUrl,
        title,
        logoUrl,
        scrapedContent,
        metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
        authorId: userId,
      },
    })

    console.log(`✅ [FIRECRAWL] Resource created: ${resource.id}`)

    return c.json({ resource })
  } catch (error) {
    console.error('Firecrawl error:', error)
    return c.json({ error: 'Failed to scrape URL' }, 500)
  }
})

// PATCH: Update an external resource (only title can be changed)
externalResourceRouter.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const resourceId = c.req.param('id')
  const { title } = await c.req.json()

  const resource = await prisma.externalResource.findFirst({
    where: {
      id: resourceId,
      authorId: userId,
    },
  })

  if (!resource) {
    return c.json({ error: 'External resource not found' }, 404)
  }

  if (!title) {
    return c.json({ error: 'Title is required' }, 400)
  }

  if (title.length > 10) {
    return c.json({ error: 'Title must be 10 characters or less' }, 400)
  }

  const updatedResource = await prisma.externalResource.update({
    where: { id: resourceId },
    data: { title },
  })

  return c.json({ resource: updatedResource })
})

// DELETE: Delete an external resource
externalResourceRouter.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const resourceId = c.req.param('id')

  const resource = await prisma.externalResource.findFirst({
    where: {
      id: resourceId,
      authorId: userId,
    },
  })

  if (!resource) {
    return c.json({ error: 'External resource not found' }, 404)
  }

  await prisma.externalResource.delete({
    where: { id: resourceId },
  })

  return c.json({ message: 'External resource deleted successfully' })
})

export default externalResourceRouter
