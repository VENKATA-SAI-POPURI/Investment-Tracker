Set WshShell = CreateObject("WScript.Shell")

' Kill process on port 5001 (Flask backend)
WshShell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -aon ^| findstr "":5001 "" ^| findstr ""LISTENING""') do taskkill /f /pid %p", 0, True

' Kill process on port 4200 (Angular frontend)
WshShell.Run "cmd /c for /f ""tokens=5"" %p in ('netstat -aon ^| findstr "":4200 "" ^| findstr ""LISTENING""') do taskkill /f /pid %p", 0, True
