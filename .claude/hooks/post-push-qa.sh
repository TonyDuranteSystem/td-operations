#!/bin/bash
# Post-push QA reminder hook
# Fires after git push to remind Claude to test the deployed changes

# Check if the push changed UI-related files
CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || echo "")

UI_CHANGED=false
for f in $CHANGED_FILES; do
  case "$f" in
    components/*|app/\(dashboard\)/*|app/portal/*|app/api/invoices/*|app/api/inbox/*|app/api/accounts/*|app/api/service-catalog/*|app/api/invoice-settings/*)
      UI_CHANGED=true
      break
      ;;
  esac
done

if [ "$UI_CHANGED" = true ]; then
  echo "🧪 QA REQUIRED: UI files were changed in this push. You MUST test in the browser before declaring done."
  echo "   → Open Chrome (tabs_context_mcp) → navigate to the changed page → screenshot → interact → verify"
  echo "   → Use Uxio Test LLC for test data"
fi
