/*
  Warnings:

  - You are about to drop the column `externalResourceId` on the `Note` table. All the data in the column will be lost.
  - You are about to drop the column `keywordPackId` on the `Note` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_externalResourceId_fkey";

-- DropForeignKey
ALTER TABLE "Note" DROP CONSTRAINT "Note_keywordPackId_fkey";

-- DropIndex
DROP INDEX "Note_externalResourceId_idx";

-- DropIndex
DROP INDEX "Note_keywordPackId_idx";

-- AlterTable
ALTER TABLE "Note" DROP COLUMN "externalResourceId",
DROP COLUMN "keywordPackId",
ADD COLUMN     "externalResourceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "keywordPackIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
