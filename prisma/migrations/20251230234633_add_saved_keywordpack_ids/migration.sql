-- AlterTable
ALTER TABLE "User" ADD COLUMN     "savedKeywordPackIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
