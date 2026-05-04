!include nsDialogs.nsh
!include LogicLib.nsh

!macro customHeader
!macroend

!ifndef BUILD_UNINSTALLER
Var HelperAutoInstall
Var HelperAutoInstallCheckbox

!macro customInit
  StrCpy $HelperAutoInstall "1"
!macroend

!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
  Page custom HelperOptionsPage HelperOptionsLeave
!macroend

Function HelperOptionsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "WFHelper can download warframe-api-helper on first launch, or you can manage the helper manually."
  Pop $0

  ${NSD_CreateCheckbox} 0 34u 100% 12u "Automatically install warframe-api-helper during first-run setup"
  Pop $HelperAutoInstallCheckbox

  ${If} $HelperAutoInstall == "1"
    ${NSD_Check} $HelperAutoInstallCheckbox
  ${EndIf}

  ${NSD_CreateLabel} 0 58u 100% 42u "Manual install path: $APPDATA\warframe-companion\api-helper\warframe-api-helper.exe$\r$\nIf you skip automatic install, download the helper yourself and place it at that path."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function HelperOptionsLeave
  ${NSD_GetState} $HelperAutoInstallCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $HelperAutoInstall "1"
  ${Else}
    StrCpy $HelperAutoInstall "0"
  ${EndIf}
FunctionEnd

!macro customInstall
  CreateDirectory "$APPDATA\warframe-companion"
  FileOpen $0 "$APPDATA\warframe-companion\setup-preferences.json" w
  ${If} $HelperAutoInstall == "1"
    FileWrite $0 '{"autoInstallHelper":true}'
  ${Else}
    FileWrite $0 '{"autoInstallHelper":false}'
  ${EndIf}
  FileClose $0
!macroend
!endif
