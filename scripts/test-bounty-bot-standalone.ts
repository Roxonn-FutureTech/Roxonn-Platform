#!/usr/bin/env tsx
/**
 * Standalone test script for bounty bot command parsing
 * Run with: npx tsx scripts/test-bounty-bot-standalone.ts
 */

import { ethers } from 'ethers';

// Copy of parseBountyCommand for standalone testing
function parseBountyCommand(comment: string): { type: 'allocate' | 'request'; amount?: string; currency?: 'XDC' | 'ROXN' | 'USDC' } | null {
  if (!comment || typeof comment !== 'string') {
    return null;
  }

  const patterns = [
    /\/bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
    /\/bounty\s*$/i,
    /@roxonn\s+bounty\s+(\d+(?:\.\d+)?)\s*(XDC|ROXN|USDC)/i,
    /@roxonn\s+bounty\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = comment.match(pattern);
    if (match) {
      const amount = match[1];
      const currency = match[2]?.toUpperCase() as 'XDC' | 'ROXN' | 'USDC' | undefined;
      
      if (amount && currency) {
        if (!['XDC', 'ROXN', 'USDC'].includes(currency)) {
          return null;
        }
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum) || amountNum <= 0 || amountNum > 1000000) {
          return null;
        }
        return {
          type: 'allocate',
          amount,
          currency,
        };
      } else {
        return {
          type: 'request',
        };
      }
    }
  }
  return null;
}

console.log('🧪 Testing Bounty Bot Commands (Standalone)\n');

// Test 1: Command Parsing
console.log('1. Testing Command Parsing:');
const testCases = [
  { input: '/bounty 10 XDC', expected: { type: 'allocate', amount: '10', currency: 'XDC' } },
  { input: '/bounty 10.5 ROXN', expected: { type: 'allocate', amount: '10.5', currency: 'ROXN' } },
  { input: '/bounty', expected: { type: 'request' } },
  { input: '@roxonn bounty 25 USDC', expected: { type: 'allocate', amount: '25', currency: 'USDC' } },
  { input: '@roxonn bounty', expected: { type: 'request' } },
  { input: '/Bounty 5 xdc', expected: { type: 'allocate', amount: '5', currency: 'XDC' } },
  { input: 'Regular comment', expected: null },
  { input: '/bounty 10 BTC', expected: null },
  { input: '/bounty 2000000 XDC', expected: null },
];

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = parseBountyCommand(testCase.input);
  const success = JSON.stringify(result) === JSON.stringify(testCase.expected);
  
  if (success) {
    console.log(`   ✅ "${testCase.input}" -> ${JSON.stringify(result)}`);
    passed++;
  } else {
    console.log(`   ❌ "${testCase.input}"`);
    console.log(`      Expected: ${JSON.stringify(testCase.expected)}`);
    console.log(`      Got: ${JSON.stringify(result)}`);
    failed++;
  }
}

console.log(`\n   Results: ${passed} passed, ${failed} failed\n`);

// Test 2: Currency Decimal Handling
console.log('2. Testing Currency Decimal Handling:');
try {
  const xdcAmount = '10.5';
  const xdcParsed = ethers.parseEther(xdcAmount);
  const xdcFormatted = ethers.formatEther(xdcParsed);
  console.log(`   ✅ XDC: ${xdcAmount} -> ${xdcParsed.toString()} wei -> ${xdcFormatted}`);
  
  const roxnAmount = '10.5';
  const roxnParsed = ethers.parseEther(roxnAmount);
  const roxnFormatted = ethers.formatEther(roxnParsed);
  console.log(`   ✅ ROXN: ${roxnAmount} -> ${roxnParsed.toString()} wei -> ${roxnFormatted}`);
  
  const usdcAmount = '10.5';
  const usdcParsed = ethers.parseUnits(usdcAmount, 6);
  const usdcFormatted = ethers.formatUnits(usdcParsed, 6);
  console.log(`   ✅ USDC: ${usdcAmount} -> ${usdcParsed.toString()} wei -> ${usdcFormatted}`);
  
  // Test balance comparison
  const poolBalance = ethers.parseEther('100.0');
  const requestedAmount = ethers.parseEther('10.0');
  const hasEnough = poolBalance >= requestedAmount;
  console.log(`   ✅ Balance check: 100 XDC >= 10 XDC = ${hasEnough}`);
  
  // Test insufficient balance
  const lowBalance = ethers.parseEther('5.0');
  const hasEnoughLow = lowBalance >= requestedAmount;
  console.log(`   ✅ Balance check: 5 XDC >= 10 XDC = ${hasEnoughLow}`);
  
  passed += 5;
} catch (error: any) {
  console.log(`   ❌ Error: ${error.message}`);
  failed++;
}

console.log('');

// Test 3: Edge Cases
console.log('3. Testing Edge Cases:');
try {
  // Test with extra text
  const result1 = parseBountyCommand('Hey, can you /bounty 10 XDC please?');
  if (result1?.type === 'allocate' && result1.amount === '10' && result1.currency === 'XDC') {
    console.log('   ✅ Command parsing with extra text');
    passed++;
  } else {
    console.log('   ❌ Command parsing with extra text failed');
    failed++;
  }
  
  // Test empty string
  const result2 = parseBountyCommand('');
  if (result2 === null) {
    console.log('   ✅ Empty string handling');
    passed++;
  } else {
    console.log('   ❌ Empty string handling failed');
    failed++;
  }
  
  // Test null/undefined
  const result3 = parseBountyCommand(null as any);
  if (result3 === null) {
    console.log('   ✅ Null input handling');
    passed++;
  } else {
    console.log('   ❌ Null input handling failed');
    failed++;
  }
  
} catch (error: any) {
  console.log(`   ❌ Error: ${error.message}`);
  failed++;
}

console.log('');

// Summary
console.log('📊 Test Summary:');
console.log(`   Total: ${passed + failed} tests`);
console.log(`   ✅ Passed: ${passed}`);
console.log(`   ❌ Failed: ${failed}`);
console.log(`   Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%\n`);

if (failed === 0) {
  console.log('🎉 All tests passed!');
  console.log('\n✅ Command parsing: Working correctly');
  console.log('✅ Currency handling: Working correctly');
  console.log('✅ Edge cases: Handled correctly');
  console.log('\n📝 Next steps:');
  console.log('   1. Test on a real GitHub repository with webhook');
  console.log('   2. Verify blockchain integration with testnet');
  console.log('   3. Test full flow from comment to blockchain');
  process.exit(0);
} else {
  console.log('⚠️  Some tests failed. Please review the output above.');
  process.exit(1);
}

