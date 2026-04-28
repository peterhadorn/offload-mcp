Output assets/demo.gif

Set Shell "zsh"
Set FontFamily "Menlo"
Set FontSize 14
Set Width 1300
Set Height 900
Set Theme "Dracula"
Set TypingSpeed 50ms
Set PlaybackSpeed 6.0

Hide
Type "cp /Users/peterhadorn/Documents/GitHub/offload-mcp/assets/sample.txt /tmp/sample.txt && cd /tmp && clear"
Enter
Sleep 500ms
Show

Type `claude --mcp-config /tmp/offload-only-mcp.json --strict-mcp-config --dangerously-skip-permissions --model claude-haiku-4-5-20251001 --effort low`
Sleep 300ms
Enter
Sleep 4s

Type "offload translation of sample.txt to mexican spanish"
Sleep 400ms
Enter

Sleep 60s
