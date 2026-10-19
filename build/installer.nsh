!include "LogicLib.nsh"
!include "FileFunc.nsh"

# TakeOne Studio safety guard (added 2026-10-15 after a data-loss incident):
# The NSIS uninstaller recursively deletes $INSTDIR. Installing into a
# non-empty folder that is NOT a previous TakeOne install would put the
# user's existing files at risk on uninstall. Refuse loudly instead.
!macro customInstall
  ${If} ${FileExists} "$INSTDIR\Uninstall TakeOne Studio.exe"
    Goto takeone_dir_ok
  ${EndIf}
  Push $0
  Push $1
  FindFirst $0 $1 "$INSTDIR\*"
  ${If} $0 != error
    ${DoUntil} $1 == ""
      ${If} $1 != "."
      ${AndIf} $1 != ".."
        FindClose $0
        MessageBox MB_OK|MB_ICONSTOP "TakeOne Studio cannot install into:$\r$\n$INSTDIR$\r$\n$\r$\nThe folder is not empty and is not a previous TakeOne Studio install. Installing here would put your existing files at risk when uninstalling.$\r$\n$\r$\nNothing was changed. Please choose an empty folder or uninstall the existing app first."
        Pop $1
        Pop $0
        Abort
      ${EndIf}
      FindNext $0 $1
    ${LoopUntil} $1 == ""
    FindClose $0
  ${EndIf}
  Pop $1
  Pop $0
  takeone_dir_ok:
!macroend
