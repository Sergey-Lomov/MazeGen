$obj = [Console]::In.ReadToEnd() | ConvertFrom-Json
$allowed = @(
  'mcp__code-index__search_code_advanced',
  'mcp__code-index__find_files',
  'mcp__code-index__get_symbol_body',
  'mcp__code-index__get_file_summary',
  'mcp__code-index__set_project_path',
  'mcp__code-index__get_settings_info',
  'mcp__code-index__build_deep_index',
  'mcp__code-index__refresh_index'
)
if ($allowed -contains $obj.tool_name) {
  @{
    hookSpecificOutput = @{
      hookEventName = 'PermissionRequest'
      permissionDecision = 'allow'
      permissionDecisionReason = 'code-index read-only tool, pre-approved'
    }
  } | ConvertTo-Json -Compress
} else {
  '{}'
}
