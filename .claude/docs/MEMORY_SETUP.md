# Memory Management Setup

This document explains how to set up the memory management system for Claude Code.

## Commands Available

### `/remember` - Add Memories

Add memories to either project or user level storage.

**Usage:**

\`\`\`bash
# Add to project memory
/remember This project uses Django REST Framework --project

# Add to user memory  
/remember Always ask for consent before running servers --user

# Prompt for memory type (will ask for 1 or 2)
/remember Database uses PostgreSQL with RLS policies
\`\`\`

### `/recall` - Search Memories

Search through both project and user memories for matching keywords.

**Usage:**

\`\`\`bash
# Search for Django-related memories
/recall Django

# Search for multiple terms
/recall security consent server

# Search for specific patterns
/recall "line length" formatting
\`\`\`

## Hook Configuration (Optional)

To enable automatic memory suggestions when the agent stops, you need to configure a hook in your Claude Code settings.

### Setup Instructions

1. **Find your Claude Code settings file:**
   - Global: `~/.claude/settings.json`
   - Project: `.claude/settings.json`

2. **Add the hook configuration:**

   \`\`\`json
   {
     "hooks": {
       "Stop": [
         {
           "matcher": "*",
           "hooks": [
             {
               "type": "command",
               "command": "echo '💡 TIP: Consider saving any learnings with /remember'"
             }
           ]
         }
       ]
     }
   }
   \`\`\`

3. **Advanced Hook (Optional):**
   For more sophisticated memory suggestions, you can use a more complex hook:

   \`\`\`json
   {
     "hooks": {
       "Stop": [
         {
           "matcher": "*",
           "hooks": [
             {
               "type": "command",
               "command": "echo '💡 Any learnings to remember?' && echo '  /remember <your learning> --project' && echo '  /remember <your learning> --user'"
             }
           ]
         }
       ]
     }
   }
   \`\`\`

## Memory File Locations

- **Project Memory:** `CLAUDE.md` (in project root)
- **User Memory:** `~/.claude/claude.md` (in your home directory)

## Memory Format

Memories are stored with timestamps in the following format:

\`\`\`markdown
## Memory Entry - 2024-01-15 14:30:22

Your memory content here

\`\`\`

## Tips

1. **Use descriptive memories:** Include context about why something is important
2. **Tag memories:** Use keywords that you'll remember when searching
3. **Regular cleanup:** Periodically review and clean up old memories
4. **Search first:** Use `/recall` before adding new memories to avoid duplicates

## Troubleshooting

- If commands don't appear, ensure files are in `.claude/commands/` directory
- If hook doesn't work, check your settings.json syntax
- If files aren't created, check permissions for the target directories
