#!/usr/bin/env node

/**
 * Project Analyzer Script
 *
 * Analyzes the current project and outputs a structured summary.
 * This script is called by the project-analyzer skill.
 */

const fs = require('fs');
const path = require('path');

function analyzeProject(projectRoot) {
  const result = {
    name: 'Unknown',
    description: 'No description',
    files: {},
    directories: [],
    keyFiles: [],
    timestamp: new Date().toISOString()
  };

  // Try to read package.json
  const packageJsonPath = path.join(projectRoot, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      result.name = pkg.name || 'Unknown';
      result.description = pkg.description || 'No description';
      result.keyFiles.push('package.json');
    } catch (e) {
      // Ignore parse errors
    }
  }

  // Check for key configuration files
  const keyFilesList = [
    'tsconfig.json',
    'README.md',
    'CLAUDE.md',
    '.env.example',
    '.gitignore',
    'Dockerfile',
    'docker-compose.yml'
  ];

  keyFilesList.forEach(file => {
    if (fs.existsSync(path.join(projectRoot, file))) {
      result.keyFiles.push(file);
    }
  });

  // Count files by extension
  function countFiles(dir, depth = 0) {
    if (depth > 3) return; // Limit depth

    try {
      const items = fs.readdirSync(dir);

      items.forEach(item => {
        if (item.startsWith('.') || item === 'node_modules') return;

        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          if (depth === 0) {
            result.directories.push(item + '/');
          }
          countFiles(fullPath, depth + 1);
        } else {
          const ext = path.extname(item).toLowerCase() || 'no-ext';
          result.files[ext] = (result.files[ext] || 0) + 1;
        }
      });
    } catch (e) {
      // Ignore permission errors
    }
  }

  countFiles(projectRoot);

  return result;
}

// Main execution
const projectRoot = process.cwd();
const analysis = analyzeProject(projectRoot);

// Output as formatted JSON
console.log('=== PROJECT ANALYSIS ===');
console.log(`Project: ${analysis.name}`);
console.log(`Description: ${analysis.description}`);
console.log(`Analyzed at: ${analysis.timestamp}`);
console.log('');
console.log('=== FILE COUNTS ===');
Object.entries(analysis.files)
  .sort((a, b) => b[1] - a[1])
  .forEach(([ext, count]) => {
    console.log(`  ${ext}: ${count}`);
  });
console.log('');
console.log('=== DIRECTORIES ===');
analysis.directories.forEach(dir => {
  console.log(`  ${dir}`);
});
console.log('');
console.log('=== KEY FILES ===');
analysis.keyFiles.forEach(file => {
  console.log(`  ✓ ${file}`);
});
console.log('');
console.log('=== END ANALYSIS ===');
