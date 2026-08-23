' dsh-web-restart launcher
' Runs the restart script fully hidden (no console window) and as an
' independent process so it survives the calling GUI's exit.
'
' Why: launching a detached cmd.exe directly creates a NEW console window on
' Windows (windowsHide is unreliable for detached processes), and if that
' window is closed the relaunch is interrupted. wscript.exe is a GUI-subsystem
' host (no console), so a launched wscript shows no window; sh.Run cmd /c
' "script", 0, False hides the console window and does not wait for the child
' (async, independent), so the restart script keeps running to completion.
If WScript.Arguments.Count < 1 Then WScript.Quit 1
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & WScript.Arguments(0) & """", 0, False
