# Records assets/demo.gif. Needs vhs, ttyd, ffmpeg; run from the repo root after `npm run build`.
# The sample repo path is passed in the TV_DEMO_DIR environment variable.
Output assets/demo.gif
Set Shell "powershell"
Set FontSize 16
Set Width 1200
Set Height 760
Set Padding 20
Set Theme "Dracula"
Set TypingSpeed 45ms

Hide
Type "function tierview { node C:/Users/melsa/tierview/dist/bin.js @args }"
Enter
Type "cd $env:TV_DEMO_DIR"
Enter
Type "clear"
Enter
Show

Type "git status --short"
Enter
Sleep 2s
Type "tierview review --dry-run"
Enter
Sleep 12s
