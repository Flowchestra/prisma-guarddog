---
description: Search memories for matching keywords
allowed-tools: [Bash, Read]
---

I'll search for memories matching: $ARGUMENTS

Let me search both project and user memories for your keywords:

\`\`\`bash
SEARCH_TERMS="$ARGUMENTS"
PROJECT_MEMORY="CLAUDE.md"
USER_MEMORY="$HOME/.claude/claude.md"
FOUND_RESULTS=false

echo "🔍 Searching memories for: $SEARCH_TERMS"
echo "=============================================="

# Search project memory first
if [ -f "$PROJECT_MEMORY" ]; then
    echo ""
    echo "📄 PROJECT MEMORY (CLAUDE.md):"
    echo "──────────────────────────────"
    
    # Use grep with case-insensitive search and context lines
    PROJECT_RESULTS=$(grep -i -C 2 "$SEARCH_TERMS" "$PROJECT_MEMORY" 2>/dev/null)
    
    if [ -n "$PROJECT_RESULTS" ]; then
        echo "$PROJECT_RESULTS"
        FOUND_RESULTS=true
    else
        echo "No matches found in project memory"
    fi
else
    echo ""
    echo "📄 PROJECT MEMORY (CLAUDE.md): File not found"
fi

# Search user memory second
if [ -f "$USER_MEMORY" ]; then
    echo ""
    echo "👤 USER MEMORY (~/.claude/claude.md):"
    echo "─────────────────────────────────────"
    
    # Use grep with case-insensitive search and context lines
    USER_RESULTS=$(grep -i -C 2 "$SEARCH_TERMS" "$USER_MEMORY" 2>/dev/null)
    
    if [ -n "$USER_RESULTS" ]; then
        echo "$USER_RESULTS"
        FOUND_RESULTS=true
    else
        echo "No matches found in user memory"
    fi
else
    echo ""
    echo "👤 USER MEMORY (~/.claude/claude.md): File not found"
fi

# Summary
echo ""
echo "=============================================="
if [ "$FOUND_RESULTS" = true ]; then
    echo "✓ Search completed - matches found above"
else
    echo "ℹ️ No matches found for '$SEARCH_TERMS'"
    echo "   Try different keywords or check your spelling"
fi
\`\`\`

The search is complete. All matching memories are displayed above with context lines for better understanding.
