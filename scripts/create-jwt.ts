#!/usr/bin/env bun

/**
 * Create user and generate JWT token
 * Usage: bun run scripts/create-jwt.ts
 */

import prisma from "../src/db";
import { generateToken } from "../src/utils/jwt";

const googleData = {
  sub: "106111294146397663976",
  email: "appturbo102@gmail.com",
  email_verified: true,
  name: "조성주",
  picture: "https://lh3.googleusercontent.com/a/ACg8ocL7Wj-Bc1q9qTi8HNNLugeupA5P6xnb2Jsqol-q4WRX_a-P6XuV=s96-c",
  given_name: "성주",
  family_name: "조",
};

async function createUserAndGenerateToken() {
  console.log("🔐 Creating user and generating JWT token...\n");
  
  try {
    // Check if user exists
    let user = await prisma.user.findUnique({
      where: { email: googleData.email },
    });

    if (user) {
      console.log(`✅ User already exists: ${user.email}`);
    } else {
      // Create user
      user = await prisma.user.create({
        data: {
          email: googleData.email,
          name: googleData.name,
          googleId: googleData.sub,
          profileUrl: googleData.picture,
        },
      });
      console.log(`✅ User created: ${user.email}`);
    }

    console.log(`📝 User ID: ${user.id}`);
    console.log(`📝 Name: ${user.name}`);
    console.log(`📝 Email: ${user.email}\n`);

    // Generate JWT
    const token = generateToken(user.id);

    console.log("🔑 JWT Token:");
    console.log("━".repeat(80));
    console.log(token);
    console.log("━".repeat(80));
    
    console.log("\n✅ Token generated successfully!");
    console.log("\n📋 Usage:");
    console.log(`   export JWT_TOKEN="${token}"`);
    console.log(`   bun run test-client.ts`);
    console.log("\n   Or:");
    console.log(`   JWT_TOKEN="${token}" bun run test-client.ts\n`);

  } catch (e) {
    console.error("❌ Error:", e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

createUserAndGenerateToken();
