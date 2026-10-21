# WO-18 "wired?" audit — har tool ko kaunsa code asal mein chalata hai (file:line) ya "none"

Method: har catalog id ke liye in files me execution path grep kiya —
main/comfy-workflows.js, main/comfy.js, main/pipeline.js, main/library.js,
main/brain.js, main/deps.js, main.js, renderer/*.js, preload.js.
"Chalana" = user action se tool ka engine/code execute hota hai
(subprocess, ComfyUI prompt, IPC handler). Install/download code (deps.js,
downloads.js) execution nahi hai.

| # | id | wired? | code jo chalata hai |
|---|----|--------|---------------------|
| 1 | brain | WIRED | main/brain.js:16 (TakeOneBrain class); main.js:986-1009 (takeone:brainLearn / takeone:brainSuggest IPC, .brain.json persist); renderer/pipeline.js:201,218 (brainSuggest/brainLearn calls) |
| 2 | image-studio | WIRED | main/comfy-workflows.js:26 (sdxlTxt2Img workflow); main.js:961-978 (takeone:comfyGenerate → ComfyManager.queuePrompt); main/comfy.js:39-61 (python main.py spawn + API); renderer/pipeline.js:223 (comfyGenerate call) |
| 3 | image-lite | WIRED (shared) | wahi code path jitna image-studio ka (ek hi sdxlTxt2Img workflow; Lightning/Turbo alag catalog entries hain, code me alag workflow nahi) |
| 4 | video-studio | none | koi video workflow/code nahi hai — comfy-workflows.js me sirf sdxlTxt2Img; pipeline STEPS me sirf label (needsTool) |
| 5 | video-quality | none | same as video-studio |
| 6 | video-pro | none | same as video-studio |
| 7 | voice-studio | none | deps.js:136 pipInstall karta hai; chatterbox ko invoke karne wala koi code nahi |
| 8 | voice-lite | none (locally) | in-app sirf official page khulti hai (external act — renderer/models.js); koi local voice engine run nahi hota |
| 9 | transcribe | none | pip install hota hai; faster_whisper invoke karne wala code nahi |
| 10 | music-studio | none | koi ACE-Step workflow/code nahi |
| 11 | upscaler | none | SwinIR run karne wala code nahi |
| 12 | face-restore | none | GFPGAN run karne wala code nahi |
| 13 | vision | none | Florence-2 run karne wala code nahi |
| 14 | smart-select | none | SAM2 run karne wala code nahi |
| 15 | erase | none | lama_cleaner invoke karne wala code nahi |
| 16 | depth-fx | none | Depth-Anything run karne wala code nahi |
| 17 | pose-lock | none | DWPose run karne wala code nahi |
| 18 | bg-remove | none | BiRefNet run karne wala code nahi |
| 19 | voice-cleanup | none | deepfilternet/df.enhance invoke karne wala code nahi (renderer/wizard.js:28 sirf wizard label hai) |
| 20 | slow-motion | none | main.js:1223 takeone:adoptPick sirf author ki files copy karta hai (setup); RIFE chalane wala code nahi |
| 21 | stem-split | none | demucs.separate invoke karne wala code nahi |

## Honest summary
- **WIRED (3):** brain, image-studio, image-lite (image-studio/image-lite ek hi workflow share karte hain).
- **none (18):** baqi sab — download/install/adopt/detection code hai (downloads.js, main/deps.js, main.js model scan), lekin koi execution path nahi. Catalog me yahi wajah hai ke wo "offered" dikhte hain lekin kuch click par nahi chalta — is audit me 7 ko unavailable kar diya gaya hai (5 pip + voice-lite + slow-motion), baqi 11 (video-studio, video-quality, video-pro, music-studio, upscaler, face-restore, vision, smart-select, depth-fx, pose-lock, bg-remove) abhi catalog me offered hain baghair execution path ke.
- Kuch fix nahi kiya gaya (WO-18 instruction).
