$text = "No multi-option breakdowns (variant A vs B, pros/cons lists, hedged 'on one hand/on the other') unless explicitly asked to compare options - give the conclusion/decision directly, skip intermediate reasoning stages in the output text."

$output = [PSCustomObject]@{
    hookSpecificOutput = [PSCustomObject]@{
        hookEventName    = "UserPromptSubmit"
        additionalContext = $text
    }
}

$output | ConvertTo-Json -Compress -Depth 5
