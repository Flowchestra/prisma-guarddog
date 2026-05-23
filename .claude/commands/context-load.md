# Context Load Command

**Command**: `/context-load`

**Purpose**: Generate a comprehensive, gitingest-style analysis of the current codebase to provide high-level project context for new chat sessions.

## Description

This command creates a detailed analysis of the current project similar to the gitingest tool, providing:
- Project overview and architecture summary
- Framework and dependency analysis  
- File hierarchy and structure
- Key technical components
- Development standards and patterns

The analysis is performed by a dedicated subagent to avoid consuming main context tokens while providing deterministic, idempotent results.

## Usage

\`\`\`bash
/context-load
\`\`\`

Optional parameters:
- `--depth=<number>` - Directory depth to analyze (default: 3)
- `--include-tests` - Include test files in analysis (default: false)
- `--format=<compact|detailed>` - Output format (default: detailed)

## Implementation

The command spawns a Claude Code subagent with the following task:

\`\`\`markdown
Analyze the current codebase and provide a comprehensive project context summary in the style of gitingest. Include:

1. **Project Summary**
   - Platform vision and purpose
   - Current architecture stack
   - Key capabilities and features

2. **Technical Architecture**
   - Framework analysis (Django, Next.js, etc.)
   - Database design patterns
   - Security architecture
   - Integration patterns

3. **Dependency Analysis**
   - Core dependencies and their purposes
   - Development tool stack
   - Version constraints and compatibility

4. **File Structure Analysis**
   - Directory organization pattern
   - Key file locations and purposes
   - Configuration file locations
   - Script and utility locations

5. **Development Standards**
   - Code style and formatting rules
   - Testing patterns and requirements
   - Security requirements
   - Performance considerations

6. **Key Integration Points**
   - External service integrations
   - API patterns and conventions
   - Authentication and authorization
   - Multi-tenant architecture

Format the output as a concise, structured summary optimized for LLM context loading.
\`\`\`

## Output Format

The command returns a structured analysis containing:

\`\`\`
# Flowchestra Backend - Project Context

## 🏗️ Architecture Overview
[High-level architecture summary]

## 🛠️ Technology Stack
[Framework and dependency breakdown]

## 📁 Directory Structure
[Key directories and file organization]

## 🔒 Security & Authentication
[Security patterns and auth architecture]

## 🏢 Multi-tenant Design
[Organization-based isolation patterns]

## 🧪 Development Workflow
[Testing, linting, and deployment patterns]

## 🔗 Key Integration Points
[External services and API patterns]

## 📋 Quick Reference
[Essential commands and file locations]
\`\`\`

## Benefits

1. **Token Efficiency**: Subagent analysis prevents context bloat
2. **Consistency**: Deterministic output for reliable context loading
3. **Onboarding**: Quick project understanding for new team members
4. **Context Refresh**: Standardized way to load project context in new chats
5. **Documentation**: Living documentation that stays current with codebase

## Files to Analyze

The subagent will examine:
- `CLAUDE.md` (project documentation)
- `pyproject.toml` / `requirements.txt` (dependencies)
- `config/settings/` (Django configuration)
- `apps/` (Django applications)
- Directory structure patterns
- Key configuration files
- Documentation files

## Error Handling

If analysis fails:
- Return cached analysis from previous successful run
- Provide minimal context with error details
- Suggest manual context loading approaches

## Caching

Analysis results are cached for 24 hours or until:
- `CLAUDE.md` is modified
- `pyproject.toml` is modified  
- New Django apps are added
- Force refresh is requested with `--refresh` flag
