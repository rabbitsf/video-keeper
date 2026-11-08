; Video Keeper Helper for Windows — Inno Setup 6 script.
; Packs dist/windows-helper (tools/windows/stage-helper.mjs) into a per-user installer: no admin
; rights, installs to %LOCALAPPDATA%\VideoKeeper\Helper (writable, so yt-dlp can update itself) and
; registers the Firefox native messaging host for the current user only.
; Built by .github/workflows/windows-helper.yml:
;   iscc /DAppVersion=<release.txt> /DHostName=<firefox-host.json name> /DSourceDir=<stage> /DOutputDir=<dir> installer.iss
; Unsigned for now: Windows SmartScreen asks "More info → Run anyway" on first run.

#ifndef AppVersion
  #error Pass /DAppVersion=<release>
#endif
#ifndef HostName
  #error Pass /DHostName=<native messaging host name>
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<staged helper folder>
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif

[Setup]
; Fixed forever: identifies the app for upgrades and uninstall.
AppId={{3441DAB0-C224-4AEF-8DD8-058708F875CD}
AppName=Video Keeper Helper
AppVersion={#AppVersion}
AppVerName=Video Keeper Helper {#AppVersion}
AppPublisher=rabbitsf
AppPublisherURL=https://github.com/rabbitsf/video-keeper
AppSupportURL=https://github.com/rabbitsf/video-keeper
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=
DefaultDirName={localappdata}\VideoKeeper\Helper
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=Video-Keeper-Helper-Setup
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Video Keeper Helper
CloseApplications=yes

[Messages]
WelcomeLabel2=This installs Video Keeper Helper, which lets the Video Keeper add-on for Firefox download YouTube videos.%n%nIt needs no administrator rights and is installed for you only.
FinishedLabel=Video Keeper Helper is installed.%n%nRestart Firefox, then open a YouTube video and click the Video Keeper button.

[InstallDelete]
; A reinstall brings a fresh starting copy of yt-dlp; let it update again right away.
Type: files; Name: "{app}\ytdlp-update.stamp"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Registry]
Root: HKCU; Subkey: "Software\Mozilla\NativeMessagingHosts\{#HostName}"; ValueType: string; ValueName: ""; ValueData: "{app}\firefox-host.json"; Flags: uninsdeletekey

[UninstallDelete]
; Files the helper writes later (updated yt-dlp, its .old copy, the update stamp).
Type: filesandordirs; Name: "{app}"
