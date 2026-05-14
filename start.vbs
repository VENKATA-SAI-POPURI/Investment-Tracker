Set WshShell = CreateObject("WScript.Shell")

' Get the folder where this script lives
strPath = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)

' Start Backend (Flask) hidden
WshShell.Run "cmd /c cd /d """ & strPath & "\backend"" && python app.py", 0, False

' Start Frontend (Angular) hidden
WshShell.Run "cmd /c cd /d """ & strPath & "\frontend"" && npx ng serve --host 0.0.0.0 --open", 0, False
