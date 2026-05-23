---
description: Add a memory to project or user level
allowed-tools: [Bash, Read, Write, Edit]
---

I'll help you save this memory. Let me analyze the arguments: $ARGUMENTS

Let me parse the arguments to determine where to save this memory:

\`\`\`bash
# Parse arguments for flags
ARGS="$ARGUMENTS"
MEMORY_TEXT=""
MEMORY_TYPE=""

# Check for --user flag
if [[ "$ARGS" == *"--user"* ]]; then
    MEMORY_TYPE="user"
    MEMORY_TEXT=$(echo "$ARGS" | sed 's/--user//g' | xargs)
# Check for --project flag
elif [[ "$ARGS" == *"--project"* ]]; then
    MEMORY_TYPE="project"
    MEMORY_TEXT=$(echo "$ARGS" | sed 's/--project//g' | xargs)
else
    MEMORY_TEXT="$ARGS"
fi

echo "Memory to save: $MEMORY_TEXT"
echo "Memory type: $MEMORY_TYPE"
\`\`\`

Now I'll determine the target file and save the memory:

\`\`\`bash
# If no memory type specified, we'll need to prompt the user
if [ -z "$MEMORY_TYPE" ]; then
    echo "Where should I save this memory?"
    echo "1 for project memory (CLAUDE.md)"
    echo "2 for user memory (~/.claude/claude.md)"
    echo "Please respond with 1 or 2"
    exit 0
fi

# Set the target file based on memory type
if [ "$MEMORY_TYPE" = "project" ]; then
    TARGET_FILE="CLAUDE.md"
else
    TARGET_FILE="$HOME/.claude/claude.md"
fi

# Create timestamp
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# Prepare memory entry
MEMORY_ENTRY="

## Memory Summary - $TIMESTAMP

$MEMORY_TEXT

"

# Check if target file exists and handle accordingly
if [ -f "$TARGET_FILE" ]; then
    echo "$MEMORY_ENTRY" >> "$TARGET_FILE"
    echo "✓ Memory added to $MEMORY_TYPE memory ($TARGET_FILE)"
else
    if [ "$MEMORY_TYPE" = "user" ]; then
        # Create user memory file with initial structure
        mkdir -p "$HOME/.claude"
        cat > "$TARGET_FILE" << 'EOF'
# Claude User Memory

This file contains user-level memories and preferences for Claude Code.

## Personal Information
- I am Henry, I am a Cybersecurity Architect by day and the CTO of a Tech Company named Byte Size Innovations.

## Workflow Principles
- Whenever we are working on something and there is a new learning, point of revelation, or other moment that we think is super pertinent to keep track of, that should be worth consideration about either adding a user or project memory, as such prompt me for adding it after we work through the current task.

## Safety and Consent Principles
- Do not automatically start the server for any projects, run any file removal commands, or run any scripts without my consent.
EOF
        echo "$MEMORY_ENTRY" >> "$TARGET_FILE"
        echo "✓ Created user memory file and added memory ($TARGET_FILE)"
    else
        # Create project memory file with initial structure
        cat > "$TARGET_FILE" << 'EOF'
# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## Development Learnings
EOF
        echo "$MEMORY_ENTRY" >> "$TARGET_FILE"
        echo "✓ Created project memory file and added memory ($TARGET_FILE)"
    fi
fi

# Show the added memory for confirmation
echo ""
echo "Memory added:"
echo "─────────────"
echo "$MEMORY_TEXT"
echo "─────────────"
\`\`\`

The memory has been processed. If you see a prompt asking for 1 or 2, please respond to specify whether this should be saved as project memory (1) or user memory (2).
