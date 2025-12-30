import prisma from '../src/db'

async function testCloudSave() {
  console.log('🧪 Testing Cloud Save Feature...\n')

  // Get two users
  const users = await prisma.user.findMany({
    take: 2,
    select: { id: true, email: true, savedKeywordPackIds: true }
  })

  if (users.length < 2) {
    console.error('❌ Need at least 2 users for testing')
    return
  }

  const [user1, user2] = users
  console.log(`👤 User 1: ${user1.email}`)
  console.log(`👤 User 2: ${user2.email}\n`)

  // Create a public KeywordPack by user1
  console.log(`📦 Creating public KeywordPack by user1...`)
  const pack = await prisma.keywordPack.create({
    data: {
      name: 'Public Test Pack',
      authorId: user1.id,
      isPublic: true,
      keywords: [
        { name: 'Test1', description: 'Test keyword 1' },
        { name: 'Test2', description: 'Test keyword 2' }
      ]
    }
  })
  console.log(`✅ Created pack: ${pack.id}\n`)

  // Simulate user2 saving user1's public pack
  console.log(`☁️ User2 saving user1's public pack...`)
  
  // Check if pack is public and not owned by user2
  if (pack.isPublic && pack.authorId !== user2.id) {
    const savedIds = user2.savedKeywordPackIds || []
    
    if (!savedIds.includes(pack.id)) {
      await prisma.user.update({
        where: { id: user2.id },
        data: {
          savedKeywordPackIds: [...savedIds, pack.id]
        }
      })
      console.log(`✅ User2 saved the pack\n`)
    } else {
      console.log(`ℹ️ Pack already saved\n`)
    }
  }

  // Retrieve user2's packs (should include saved pack)
  console.log(`📋 Retrieving user2's packs...`)
  
  const user2Updated = await prisma.user.findUnique({
    where: { id: user2.id },
    select: { savedKeywordPackIds: true }
  })

  const user2SavedIds = user2Updated?.savedKeywordPackIds || []

  // Get own packs
  const ownPacks = await prisma.keywordPack.findMany({
    where: { authorId: user2.id },
    select: {
      id: true,
      name: true,
      isPublic: true,
      authorId: true,
    }
  })

  // Get saved public packs
  const savedPacks = user2SavedIds.length > 0
    ? await prisma.keywordPack.findMany({
        where: {
          id: { in: user2SavedIds },
          isPublic: true
        },
        select: {
          id: true,
          name: true,
          isPublic: true,
          authorId: true,
        }
      })
    : []

  console.log(`\n📊 User2's KeywordPacks:`)
  console.log(`   Own packs: ${ownPacks.length}`)
  ownPacks.forEach(p => {
    console.log(`      - ${p.name} (isOwned: true, isSaved: false)`)
  })
  
  console.log(`   Saved packs: ${savedPacks.length}`)
  savedPacks.forEach(p => {
    console.log(`      - ${p.name} (isOwned: false, isSaved: true)`)
  })

  // Test unsave
  console.log(`\n🗑️ User2 unsaving the pack...`)
  await prisma.user.update({
    where: { id: user2.id },
    data: {
      savedKeywordPackIds: user2SavedIds.filter(id => id !== pack.id)
    }
  })
  console.log(`✅ Pack unsaved\n`)

  // Cleanup
  console.log(`🧹 Cleaning up...`)
  await prisma.keywordPack.delete({ where: { id: pack.id } })
  console.log(`✅ Test pack deleted\n`)

  console.log(`✨ Test completed!`)
}

testCloudSave()
  .catch(e => {
    console.error('❌ Error:', e)
    process.exit(1)
  })
  .finally(() => {
    prisma.$disconnect()
  })
