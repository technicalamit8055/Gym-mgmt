; Added to the installer electron-builder makes (package.json → build.nsis.include).
;
; Studio adds itself to the board's start-at-login list when it first runs
; (main.js, LOGIN_ITEM). Uninstalling removes that entry, so Windows is not left
; starting a program that is gone. An upgrade also runs the old uninstaller;
; then the entry stays, and the new version writes it again anyway.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "CoachBook Studio"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "CoachBook Studio"
  ${endIf}
!macroend
