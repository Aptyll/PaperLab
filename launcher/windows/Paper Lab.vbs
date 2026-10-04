' Paper Lab launcher for Windows.
'
' The desktop icon runs this. It is the only way Paper Lab starts: nothing is
' added to Windows startup, the Startup folder, scheduled tasks or the registry.
'
' What it does:
'   1. If Paper Lab is already running, just opens the page.
'   2. Otherwise starts it hidden (no black window) with live data OFF,
'      waits until it answers, then opens the page in Chrome (or your default
'      browser if Chrome isn't installed).
' Nothing is fetched or traded until you press "Turn On Live Data" on the page.
' The Quit button on the page shuts everything down.

Option Explicit

Dim shell, fso, root, url, i
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' This file lives in <Paper Lab folder>\launcher\windows
root = fso.GetParentFolderName(fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)))
url = "http://localhost:4317/"

If Not IsUp() Then
  If Not fso.FolderExists(root & "\data") Then fso.CreateFolder root & "\data"
  shell.CurrentDirectory = root
  ' Window style 0 = hidden. Output goes to data\paper-lab.log.
  shell.Run "cmd /c node --disable-warning=ExperimentalWarning src\main.js --paused >> ""data\paper-lab.log"" 2>&1", 0, False
  For i = 1 To 40
    WScript.Sleep 500
    If IsUp() Then Exit For
  Next
  If Not IsUp() Then
    MsgBox "Paper Lab didn't start." & vbCrLf & vbCrLf & _
      "The details are in data\paper-lab.log inside the Paper Lab folder." & vbCrLf & _
      "Most often this means Node isn't installed (see SETUP.md).", vbExclamation, "Paper Lab"
    WScript.Quit 1
  End If
End If

OpenPage
WScript.Quit 0

Function IsUp()
  Dim http, ok
  ok = False
  On Error Resume Next
  Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  http.setTimeouts 1000, 1000, 1000, 1000
  http.Open "GET", url & "api/status", False
  http.Send
  If Err.Number = 0 Then
    If http.Status = 200 Then ok = True
  End If
  Err.Clear
  On Error GoTo 0
  IsUp = ok
End Function

Sub OpenPage()
  On Error Resume Next
  shell.Run "chrome.exe " & url, 1, False
  If Err.Number <> 0 Then
    Err.Clear
    shell.Run url, 1, False
  End If
  On Error GoTo 0
End Sub
