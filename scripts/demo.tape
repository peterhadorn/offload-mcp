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
Type "cd /tmp && clear"
Enter
Sleep 500ms
Show

Type `claude --mcp-config /tmp/offload-only-mcp.json --strict-mcp-config --dangerously-skip-permissions --model claude-haiku-4-5-20251001 --effort low`
Sleep 300ms
Enter
Sleep 4s

Type "use offload's freeform task to translate this into mexican spanish: "
Set TypingSpeed 5ms
Type "Hier sind ein paar empfehlenswerte Anwälte in Bern. AdvoBern ist eine gute Kanzlei für Familienrecht, Arbeitsrecht und Strafrecht. Dr. Lukas Bürge ist Fachanwalt für Strafverteidigung und bietet auch 24h-Notfallpikett bei Verhaftung oder Hausdurchsuchung."
Set TypingSpeed 50ms
Sleep 400ms
Enter

Sleep 60s
