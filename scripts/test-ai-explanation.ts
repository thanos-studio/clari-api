import prisma from '../src/db'
import { AzureOpenAI } from 'openai'

const azureClient = new AzureOpenAI({
  apiVersion: process.env.AZURE_API_VERSION ?? "2023-07-01-preview",
  endpoint: process.env.AZURE_ENDPOINT,
  apiKey: process.env.AZURE_API_KEY,
})

const AZURE_DEPLOYMENT = process.env.AZURE_DEPLOYMENT_NAME ?? "gpt-4"

async function testAIExplanation() {
  console.log('🧪 Testing AI Explanation Feature...\n')

  // Get a user
  const user = await prisma.user.findFirst({
    select: { id: true, email: true, role: true }
  })

  if (!user) {
    console.error('❌ No users found')
    return
  }

  console.log(`👤 Using user: ${user.email}`)
  console.log(`   Role: ${user.role || '(none)'}\n`)

  // Get a note with transcript
  const note = await prisma.note.findFirst({
    where: {
      authorId: user.id,
      recordingStatus: 'completed',
      content: { not: null }
    },
    orderBy: { createdAt: 'desc' }
  })

  if (!note) {
    console.error('❌ No completed notes found')
    console.log('💡 Please record a note first using the recording endpoint')
    return
  }

  console.log(`📝 Using note: ${note.title}`)
  console.log(`   ID: ${note.id}\n`)

  // Extract transcript
  let fullTranscript = ''
  let formattedTranscript = ''
  
  try {
    const content = JSON.parse(note.content || '{}')
    fullTranscript = content.text || ''
    formattedTranscript = content.formatted_text || fullTranscript
  } catch (e) {
    console.error('⚠️ Failed to parse note content')
    return
  }

  console.log(`📄 Transcript preview:`)
  console.log(`   ${formattedTranscript.substring(0, 200)}...`)
  console.log(`   Total length: ${formattedTranscript.length} chars\n`)

  // Select a sentence to explain (first sentence)
  const sentences = formattedTranscript.split(/[.!?]/).filter(s => s.trim().length > 10)
  if (sentences.length === 0) {
    console.error('❌ No sentences found in transcript')
    return
  }

  const testSentence = sentences[0].trim()
  console.log(`🎯 Sentence to explain:`)
  console.log(`   "${testSentence}"\n`)

  // Build prompt
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
"${testSentence}"

위 문장에 대해 맥락을 고려하여 설명해주세요.`

  console.log(`🤖 Calling GPT for explanation...`)
  const startTime = Date.now()

  try {
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

    console.log(`✅ Generated in ${elapsedTime}ms\n`)
    console.log(`📖 Explanation:`)
    console.log(`${explanation}\n`)

    console.log(`✨ Test completed successfully!`)
  } catch (error) {
    console.error('❌ Error:', error)
  }
}

testAIExplanation()
  .catch(e => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(() => {
    prisma.$disconnect()
  })
