-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "Note_lastUpdated_idx" ON "Note"("lastUpdated");
