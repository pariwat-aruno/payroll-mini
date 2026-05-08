#!/usr/bin/env node
/**
 * tests/run.js — Test runner
 * Run: node tests/run.js
 *
 * Runs all .test.js files in this directory.
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js'));

let allPassed = true;
for (const f of files) {
  console.log('\n=== ' + f + ' ===');
  try {
    execSync(`node ${path.join(dir, f)}`, { stdio: 'inherit' });
  } catch (e) {
    allPassed = false;
  }
}

console.log('\n' + (allPassed ? '✅ All test files passed' : '❌ Some test files failed'));
process.exit(allPassed ? 0 : 1);
