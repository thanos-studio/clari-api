-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "externalResourceId" TEXT;

-- CreateTable
CREATE TABLE "ExternalResource" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "displayUrl" TEXT NOT NULL,
    "title" VARCHAR(10) NOT NULL,
    "logoUrl" TEXT,
    "scrapedContent" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "authorId" TEXT NOT NULL,

    CONSTRAINT "ExternalResource_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalResource_authorId_idx" ON "ExternalResource"("authorId");

-- CreateIndex
CREATE INDEX "Note_externalResourceId_idx" ON "Note"("externalResourceId");

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_externalResourceId_fkey" FOREIGN KEY ("externalResourceId") REFERENCES "ExternalResource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalResource" ADD CONSTRAINT "ExternalResource_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
