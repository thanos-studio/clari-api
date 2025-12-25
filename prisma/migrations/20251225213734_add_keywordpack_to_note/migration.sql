-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "keywordPackId" TEXT;

-- CreateIndex
CREATE INDEX "Note_keywordPackId_idx" ON "Note"("keywordPackId");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_keywordPackId_fkey" FOREIGN KEY ("keywordPackId") REFERENCES "KeywordPack"("id") ON DELETE SET NULL ON UPDATE CASCADE;
