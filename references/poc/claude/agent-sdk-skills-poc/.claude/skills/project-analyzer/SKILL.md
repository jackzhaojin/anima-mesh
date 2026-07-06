---
name: project-analyzer
description: Analyze project structure and generate a summary report. Use when user says "analyze project", "project summary", "what's in this project", or asks about codebase structure.
version: 1.0.0
---

# Project Analyzer Skill

Analyze the current project and generate a structured summary using the bundled analysis script.

## How To Use This Skill

1. **Run the analysis script** to get project metrics:
   ```bash
   node {skill_base_dir}/scripts/analyze.js
   ```

2. **Read the script output** - it provides:
   - Project name and description (from package.json)
   - File counts by type
   - Directory structure
   - Key configuration files found

3. **Present the results** in a clean format to the user

## Script Location

The analysis script is located at:
```
{skill_base_dir}/scripts/analyze.js
```

Where `{skill_base_dir}` is the base directory shown at the top of this skill's content.

## Example Output Format

```
## Project Analysis: {project-name}

**Description**: {from package.json}

### Structure
- TypeScript files: X
- JavaScript files: Y
- Markdown files: Z

### Key Files
- package.json ✓
- tsconfig.json ✓
- README.md ✓

### Directories
- src/
- test/
- ...
```

## When This Applies

- User asks about project structure
- User wants a project summary
- User asks "what is this codebase"
- User says "analyze this project"
