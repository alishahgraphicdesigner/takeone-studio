================================================================
 TakeOne Studio {{VERSION}} — Setup README
================================================================
Released: {{DATE}}

WHAT IS THIS
-----------
TakeOne Studio is a local AI film studio for Windows. Everything runs
on your own PC - no cloud, no subscriptions, no per-use cost.

SYSTEM REQUIREMENTS
-------------------
- Windows 10 / 11 (64-bit)
- 8 GB RAM minimum (16 GB+ recommended)
- NVIDIA GPU with 8 GB+ VRAM recommended (for video AI tools)
- ~5 GB free for the app + Python; AI models download on demand
  (each model shows its exact size before you download it)

INSTALLATION
------------
1. Run TakeOne-Studio-{{VERSION}}-setup.exe
2. One click - the installer needs no choices from you.
3. The first-run wizard checks your PC, asks where to keep your
   library, and lets you pick which AI tools to download.

WHAT THE INSTALLER DOES
-----------------------
- Installs the app into its own folder (per-user, no admin needed).
- On first run it unpacks its own Python - you don't need Python.
- AI models are NEVER bundled (they're tens of GB). You download
  only what you need, from inside the app, with pause/resume.

YOUR DATA
---------
Your library lives in:  Documents\TakeOne
  Models/    - downloaded AI models (re-downloadable anytime)
  Projects/  - YOUR CREATIONS (films, images, voice work)
  Trash/     - deleted items stay recoverable for 30 days

UNINSTALL SAFETY
----------------
Uninstalling removes ONLY the app's own folder - your library is
never touched. Before anything is removed, the app itself shows you
exactly what will be deleted and what will stay. (Details live in
the app at uninstall time, not here - that's where the decision
happens.)

TROUBLESHOOTING
---------------
- "No compatible GPU": the app still works; heavy video tools stay
  locked until a capable GPU is present.
- Slow downloads: pause/resume is safe; files are verified by
  checksum after download.
- To start completely fresh, delete Documents\TakeOne yourself -
  the app will never do this for you.

WHAT'S NEW IN THIS VERSION
--------------------------
{{CHANGELOG}}

================================================================
 (c) 2026 TakeOne Studio. This README is generated at build time,
 so the version and date above always match the installer.
================================================================
