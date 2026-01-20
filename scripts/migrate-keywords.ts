import prisma from '../src/db'

async function migrateKeywords() {
  console.log('🚀 Starting keyword migration...')
  
  const keywordPacks = await prisma.keywordPack.findMany()
  console.log(`📦 Found ${keywordPacks.length} keyword packs`)
  
  for (const pack of keywordPacks) {
    const keywords = pack.keywords as Array<{ 
      name: string
      description: string
      synonyms?: string[]
      koreanPronunciation?: string
    }>
    
    if (!Array.isArray(keywords)) continue
    
    let updated = false
    const updatedKeywords = keywords.map(k => {
      // Pattern: "RDS (Relational Database Service)" -> extract "RDS" and "Relational Database Service" as synonyms
      const match = k.name.match(/^([A-Z0-9]+)\s*\((.+)\)$/)
      if (match) {
        const [, abbreviation, fullName] = match
        const existingSynonyms = k.synonyms || []
        const newSynonyms = [abbreviation, fullName, ...existingSynonyms]
        const uniqueSynonyms = [...new Set(newSynonyms)]
        
        if (uniqueSynonyms.length !== existingSynonyms.length) {
          updated = true
          console.log(`   📝 "${k.name}" -> synonyms: [${uniqueSynonyms.join(', ')}]`)
        }
        
        return {
          ...k,
          synonyms: uniqueSynonyms
        }
      }
      return k
    })
    
    if (updated) {
      await prisma.keywordPack.update({
        where: { id: pack.id },
        data: { keywords: updatedKeywords }
      })
      console.log(`✅ Updated pack: "${pack.name}"`)
    }
  }
  
  console.log('🎉 Migration complete!')
  process.exit(0)
}

migrateKeywords().catch(e => {
  console.error('❌ Migration failed:', e)
  process.exit(1)
})
