/* TakeOne Studio 2.2.0 — Phase B: signed model catalog.
 * 21 tools, honest labels. Pure data + validation; exported for unit tests.
 *
 * Label legend (UI):
 *   "Untested on this PC" — default; flips only after an on-PC smoke test passes.
 *   "Expected · untested" — reasoned to work, not yet proven here.
 *   "Tested" — DERIVED state only; never a hardcoded string (Gate 2).
 *
 * installType:
 *   file     — direct URL via the aria2c download manager (pause/resume/checksum).
 *   hf       — Hugging Face repo via huggingface_hub snapshot_download (in-app, one click).
 *   pip      — Python package via the in-app dependency installer (no terminal).
 *   external — official vendor page; app opens it and adopts downloaded files (no manual moves).
 *   adopt    — author-hosted files (e.g. Google Drive); app opens the page, user picks
 *              the folder, app copies+verifies itself. No manual file moving.
 *
 * Size honesty: "sizeMB" is a planning estimate (spec §3). The download manager
 * reports REAL bytes from the server; estimates never drive progress bars.
 * "sizeBytes" when measured from a real file (SwinIR, GFPGAN, SAM2 below).
 *
 * unavailable: '<reason>' — the tool is listed for honesty but must NOT be
 * offered for install until the reason clears (WO-6; evidence comes from WO-8).
 * Its installBytes/firstRunBytes/installScope are null while withheld.
 */
'use strict';
const crypto = require('crypto');

const SWINIR_SHA256 = '4e78e33f22c1aa8a773db0cf4a7381bae97c2362c717f155439ebc690cbd9215'; // measured 2026-10-15
const SWINIR_BYTES = 67869037;   // measured 2026-10-15 (spec's ~12MB inference was wrong)
const GFPGAN_BYTES = 348632874;  // from release metadata 2026-10-15
const SAM2_BYTES = 155906050;    // measured via HEAD 2026-10-15

const CATALOG = [
  {
    id: 'brain', group: 'AI Brain',
    friendlyName: 'Brain', technical: 'Qwen3 8B Q4_K_M (llama.cpp)',
    installType: 'file',
    url: 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf',
    fileName: 'qwen3-8b-q4_k_m.gguf', sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785',
    sizeMB: 4795, sizeBytes: 5027783488, vramMB: 6144,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'text',
    why: 'The assistant brain — suggestions, explanations and workflow help.',
  },
  {
    id: 'image-studio', group: 'Image',
    friendlyName: 'Image Studio', technical: 'SDXL-Lightning 4-step',
    installType: 'file',
    url: 'https://huggingface.co/ByteDance/SDXL-Lightning/resolve/main/sdxl_lightning_4step.safetensors',
    fileName: 'sdxl_lightning_4step.safetensors', sha256: 'e0d996ee0013e79d9d3561f50fcafb9a17e3ff07b780358e3b66d67932c4d490',
    sizeMB: 6616, sizeBytes: 6938040682, vramMB: 8192,
    license: 'OpenRAIL++-M', licenseNote: 'Free to use, including commercially, within the license use-restrictions (see About → Licenses).',
    category: 'image',
    why: 'Fast, high-quality image generation in 4 steps.',
  },
  {
    id: 'image-lite', group: 'Image',
    friendlyName: 'Image Lite', technical: 'SDXL-Turbo (fp16)',
    installType: 'file',
    url: 'https://huggingface.co/stabilityai/sdxl-turbo/resolve/main/sd_xl_turbo_1.0_fp16.safetensors',
    fileName: 'sd_xl_turbo_1.0_fp16.safetensors', sha256: 'e869ac7d6942cb327d68d5ed83a40447aadf20e0c3358d98b2cc9e270db0da26',
    sizeMB: 6617, sizeBytes: 6938081905, vramMB: 6144,
    license: 'OpenRAIL++-M', licenseNote: 'Free to use, including commercially, within the license use-restrictions (see About → Licenses).',
    category: 'image',
    why: 'Lighter image model for smaller GPUs.',
  },
  {
    id: 'video-studio', group: 'Video',
    friendlyName: 'Video Studio', technical: 'Wan 2.1 1.3B',
    installType: 'hf', repo: 'Wan-AI/Wan2.1-T2V-1.3B',
    commit: '37ec512624d61f7aa208f7ea8140a131f93afc9a',
    files: [
      { path: 'models_t5_umt5-xxl-enc-bf16.pth', bytes: 11361920418, sha256: '7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d' },
      { path: 'diffusion_pytorch_model.safetensors', bytes: 5676070424, sha256: '96b6b242ca1c2f24e9d02cd6596066fab6d310e2d7538f33ae267cb18d957e8f' },
      { path: 'Wan2.1_VAE.pth', bytes: 507609880, sha256: '38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981' },
      { path: 'google/umt5-xxl/tokenizer.json', bytes: 16837417, sha256: '6e197b4d3dbd71da14b4eb255f4fa91c9c1f2068b20a2de2472967ca3d22602b' },
      { path: 'google/umt5-xxl/spiece.model', bytes: 4548313, sha256: 'e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458' },
      { path: 'examples/i2v_input.JPG', bytes: 250628, sha256: '077e3d965090c9028c69c00931675f42e1acc815c6eb450ab291b3b72d211a8e' },
      { path: 'google/umt5-xxl/tokenizer_config.json', bytes: 61728, sha256: 'ed9a3a8b0faa71a70a32847e0435fe036e6e112d4df4edb7bb48a921e344dc05' },
      { path: 'LICENSE.txt', bytes: 11357, sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4' },
      { path: 'google/umt5-xxl/special_tokens_map.json', bytes: 6623, sha256: '7b8a9f5040adb67b5805abdfd42c1f8d0f3d0e711f10726580eb3789cd0ad61d' },
      { path: 'config.json', bytes: 249, sha256: 'ab37994c43740513f94b3ba6233a784035a67b43c8cde83c8f31aa90468c67ce' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 16753, sizeBytes: 17567317037, vramMB: 8400,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'video',
    why: 'Text-to-video and image-to-video. The primary video engine.',
  },
  {
    id: 'video-quality', group: 'Video',
    friendlyName: 'Video Quality', technical: 'Allegro 2.8B',
    installType: 'hf', repo: 'rhymes-ai/Allegro',
    commit: 'c1b9207bb5cb79e2aa08f3d139c17d26c0de55b6',
    files: [
      { path: 'text_encoder/pytorch_model-00002-of-00002.bin', bytes: 9597031749, sha256: '4f68f80678299ac59f69b3550ebd47b966571920d8f9e71f42ab61fabaaed868' },
      { path: 'text_encoder/pytorch_model-00001-of-00002.bin', bytes: 9452285635, sha256: '2f71ad0624095dae788b1023081dda1b4040bd24f7244a5b5b46eebc09825839' },
      { path: 'transformer/diffusion_pytorch_model.safetensors', bytes: 5543894392, sha256: '6927dcc812841c1da549bf11c97ddf30532aee0e708a6642fa64cf8e0dfcdef7' },
      { path: 'text_encoder/model-00002-of-00004.safetensors', bytes: 4999830656, sha256: 'b8ed6556d7507e38af5b428c605fb2a6f2bdb7e80bd481308b865f7a40c551ca' },
      { path: 'text_encoder/model-00001-of-00004.safetensors', bytes: 4989319680, sha256: '7a68b2c8c080696a10109612a649bc69330991ecfea65930ccfdfbdb011f2686' },
      { path: 'text_encoder/model-00003-of-00004.safetensors', bytes: 4865612720, sha256: 'c831635f83041f83faf0024b39c6ecb21b45d70dd38a63ea5bac6c7c6e5e558c' },
      { path: 'text_encoder/model-00004-of-00004.safetensors', bytes: 4194506688, sha256: '02a5f2d69205be92ad48fe5d712d38c2ff55627969116aeffc58bd75a28da468' },
      { path: 'vae/diffusion_pytorch_model.safetensors', bytes: 699904972, sha256: '47871a698b18f92f15019d361a81cbc8af4676f8eef9a47fd2b95354a39f831a' },
      { path: 'gallery.gif', bytes: 26451692, sha256: '21ad9c2cf06108f0882104cafcf45c8aa65e73862588af5732cf3d37d211cbc5' },
      { path: 'tokenizer/spiece.model', bytes: 791656, sha256: 'd60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86' },
      { path: 'banner_white.gif', bytes: 627425, sha256: '127138f1dce5b768c39931f968d6c02485ec51e48bc53b24a235367314b758ae' },
      { path: 'tokenizer/tokenizer_config.json', bytes: 20617, sha256: '83b3e7737eef754efca607d9f580798cc35457daa96052cc60179f095a375c14' },
      { path: 'text_encoder/pytorch_model.bin.index.json', bytes: 19957, sha256: '7751e0a541f76c327abd714ac25eba8a35909cdcdd173ce06c0880a2c311958c' },
      { path: 'text_encoder/model.safetensors.index.json', bytes: 19886, sha256: 'a545bb25dc0f423d84be7b577311bba8bb7c6931f1eefcea65fc8b0a61a60a76' },
      { path: 'tokenizer/added_tokens.json', bytes: 2593, sha256: 'ea5a91a3234f66ea642c8e672d67f0f493759a9bee6910ae304ea9b9492118b5' },
      { path: 'tokenizer/special_tokens_map.json', bytes: 2543, sha256: '7a1985a994c41886db38c719d2a3d2f40606663cc19d7c5d6a85d349320e06d2' },
      { path: 'vae/config.json', bytes: 803, sha256: '032bf14c52d750184e15233e3f10c6638f9513c09e13016b25b5486a4203e1dc' },
      { path: 'text_encoder/config.json', bytes: 711, sha256: 'c31eecb974912cb24329a2840153db8e4a8cead9a81101c69f7ccd34bfff3e9c' },
      { path: 'transformer/config.json', bytes: 707, sha256: '6699cbd716687e0f18690c05697a8e9ecda681a54cb6506bd2b46010475918e6' },
      { path: 'model_index.json', bytes: 414, sha256: '36c56a25fdc09ebfbff06589d5b4c4586bcd71e5efb39b4469ee212ab12bd060' },
      { path: 'scheduler/scheduler_config.json', bytes: 340, sha256: '2db5e162aa3b140f9a38a1d2a72fcf440fa6ea6dcd9e70ed618e31aeccf8ab35' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 42315, sizeBytes: 44370325836, vramMB: 9523,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'video',
    why: 'Higher-fidelity video for cards with more VRAM.',
  },
  {
    id: 'video-pro', group: 'Video',
    friendlyName: 'Video Pro', technical: 'Wan 2.2 TI2V-5B',
    installType: 'hf', repo: 'Wan-AI/Wan2.2-TI2V-5B',
    commit: '921dbaf3f1674a56f47e83fb80a34bac8a8f203e',
    files: [
      { path: 'models_t5_umt5-xxl-enc-bf16.pth', bytes: 11361920418, sha256: '7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d' },
      { path: 'diffusion_pytorch_model-00002-of-00003.safetensors', bytes: 9995661736, sha256: '09ec5ef720d8396f6cfa51fbdcbdb2327e37722afd6e89fd38f1e7e5e782c283' },
      { path: 'diffusion_pytorch_model-00001-of-00003.safetensors', bytes: 9825014472, sha256: '720b06c4ade5e87c1246bba8ac95b664c638749cd9b102cf84d823bb44c026a1' },
      { path: 'Wan2.2_VAE.pth', bytes: 2818839170, sha256: '20eb789667fa5e60e7516bf509512f6cb61f01b0aa0695eadaea930c13892b36' },
      { path: 'diffusion_pytorch_model-00003-of-00003.safetensors', bytes: 178558176, sha256: '6306f7894c345de9093ad588771c2abfaeb668a81f7a6d9a918bd26ba3568e49' },
      { path: 'google/umt5-xxl/tokenizer.json', bytes: 16837417, sha256: '6e197b4d3dbd71da14b4eb255f4fa91c9c1f2068b20a2de2472967ca3d22602b' },
      { path: 'google/umt5-xxl/spiece.model', bytes: 4548313, sha256: 'e3909a67b780650b35cf529ac782ad2b6b26e6d1f849d3fbb6a872905f452458' },
      { path: 'examples/i2v_input.JPG', bytes: 250628, sha256: '077e3d965090c9028c69c00931675f42e1acc815c6eb450ab291b3b72d211a8e' },
      { path: 'diffusion_pytorch_model.safetensors.index.json', bytes: 72865, sha256: 'bfa2337f1163e195d24151a72298daf34a620543898109be47e414c8daa5b3fe' },
      { path: 'google/umt5-xxl/tokenizer_config.json', bytes: 61728, sha256: 'ed9a3a8b0faa71a70a32847e0435fe036e6e112d4df4edb7bb48a921e344dc05' },
      { path: 'google/umt5-xxl/special_tokens_map.json', bytes: 6623, sha256: '7b8a9f5040adb67b5805abdfd42c1f8d0f3d0e711f10726580eb3789cd0ad61d' },
      { path: '.msc', bytes: 507, sha256: 'e08718041f55dc3bfa49e18e8228c49bb760c477f2501214361326327e2f8c4f' },
      { path: 'config.json', bytes: 251, sha256: 'd1fea36899d00c2501b836c13ad65af56e2f9529ba622e50886d3f5c3e6c02bc' },
      { path: 'configuration.json', bytes: 43, sha256: 'a6b66993e9da0feaba8d42d06b21ad9cfaf7d8b591f32fd639ae35b7f5d2d859' },
      { path: '.mv', bytes: 36, sha256: '2b49c3a970f900cd3e1cbd1c68ca5efccaba49cdb121eeca5c51b53173558895' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 32617, sizeBytes: 34201772383, vramMB: 24576,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'video',
    why: 'Top-tier video quality. Needs a 24 GB VRAM card.',
    tier24: true,
  },
  {
    id: 'voice-studio', group: 'Voice',
    friendlyName: 'Voice Studio', technical: 'Chatterbox TTS',
    installType: 'pip', pipPackage: 'chatterbox-tts==0.1.7', installBytes: null,
    installScope: null, firstRunBytes: null,
    unavailable: 'Not available yet: CI-measured (run 39242332869), the Windows pip install pulls CPU-only torch for chatterbox-tts==0.1.7 — the GPU voice path is unproven. Withheld until real Windows install + import evidence (WO-8).',
    url: null, fileName: null, sha256: null,
    sizeMB: 9214, vramMB: 4096,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'audio',
    why: 'Natural voiceover and voice cloning.',
  },
  {
    id: 'voice-lite', group: 'Voice',
    friendlyName: 'Voice Lite', technical: 'Piper (optional)',
    installType: 'external',
    externalUrl: 'https://github.com/rhasspy/piper/releases',
    url: null, fileName: null, sha256: null,
    sizeMB: 150, vramMB: 0,
    license: 'MIT (engine)', licenseNote: 'Piper is MIT, but it needs espeak-ng (GPL-3.0) — not bundled. Install it yourself from the official page; TakeOne will detect it.',
    category: 'audio',
    why: 'Tiny, fast offline voices. You fetch it from the official page.',
  },
  {
    id: 'transcribe', group: 'Audio',
    friendlyName: 'Transcribe', technical: 'faster-whisper (large-v3 model auto-download)',
    installType: 'pip', pipPackage: 'faster-whisper==1.2.1', installBytes: null,
    installScope: null, firstRunBytes: null,
    url: null, fileName: null, sha256: null,
    sizeMB: 3385, vramMB: 4096,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'audio',
    why: 'Speech-to-text for captions and transcripts.',
  },
  {
    id: 'music-studio', group: 'Audio',
    friendlyName: 'Music Studio', technical: 'ACE-Step v1.5',
    installType: 'hf', repo: 'ACE-Step/Ace-Step1.5',
    commit: '19671f406d603126926c1b7e2adc169acbcade22',
    files: [
      { path: 'acestep-v15-turbo/model.safetensors', bytes: 4787825604, sha256: '3f6e0797fad420a39bd33979eb6e840e30989e34a3794e843d23b60ec6e422d7' },
      { path: 'acestep-5Hz-lm-1.7B/model.safetensors', bytes: 3708521528, sha256: 'f161689da73e5ecefa28ff780d51c2d92a00f056d021d7933c779ed5c6cd7db8' },
      { path: 'Qwen3-Embedding-0.6B/model.safetensors', bytes: 1191586416, sha256: '0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd' },
      { path: 'vae/diffusion_pytorch_model.safetensors', bytes: 337431388, sha256: 'da17edb604c40deaf09e9b24974e590d1ca83a374070e5d0884cfa4bed9a99b0' },
      { path: 'acestep-5Hz-lm-1.7B/tokenizer.json', bytes: 24321939, sha256: '35af56c3f5cb3ea2cc578aa28a8937770981d504f183ac5c8c38baf4bbd4af4d' },
      { path: 'acestep-5Hz-lm-1.7B/tokenizer_config.json', bytes: 14072925, sha256: '6cd70cdd89425971794f5235562edcc608b0629a6c4686ae51a8b8c8b8ba5e95' },
      { path: 'Qwen3-Embedding-0.6B/tokenizer.json', bytes: 11423705, sha256: 'def76fb086971c7867b829c23a26261e38d9d74e02139253b38aeb9df8b4b50a' },
      { path: 'acestep-v15-turbo/silence_latent.pt', bytes: 3841215, sha256: 'a778e9dd942f5e8b2c09c55370782d318834432b03dabbcdf70e6ed49ad6358b' },
      { path: 'Qwen3-Embedding-0.6B/vocab.json', bytes: 2776833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' },
      { path: 'acestep-5Hz-lm-1.7B/vocab.json', bytes: 2776833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' },
      { path: 'acestep-5Hz-lm-1.7B/added_tokens.json', bytes: 2217787, sha256: 'db08b66a515fb5d6acca0b3492d25bb44e0deda6241fc1113ac0679d40558c48' },
      { path: 'acestep-5Hz-lm-1.7B/special_tokens_map.json', bytes: 1824199, sha256: '76e233bfc357b0b03d7b6e6ba8e799244f358552575a7cdadb78d3d19106b298' },
      { path: 'Qwen3-Embedding-0.6B/merges.txt', bytes: 1671853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' },
      { path: 'acestep-5Hz-lm-1.7B/merges.txt', bytes: 1671853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' },
      { path: 'acestep-v15-turbo/modeling_acestep_v15_turbo.py', bytes: 96036, sha256: 'c1ab0dd547124fee7ada449b2b86eae8201dc7d15889932643bbb67e3c982444' },
      { path: 'acestep-v15-turbo/configuration_acestep_v15.py', bytes: 13130, sha256: 'b89870c5c7a7ce060eb0bcdbb5ffc86b0b1a324ca325a26be552ea1b42496dc5' },
      { path: 'Qwen3-Embedding-0.6B/tokenizer_config.json', bytes: 5404, sha256: '443bfa629eb16387a12edbf92a76f6a6f10b2af3b53d87ba1550adfcf45f7fa0' },
      { path: 'acestep-5Hz-lm-1.7B/chat_template.jinja', bytes: 4168, sha256: 'a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8' },
      { path: 'Qwen3-Embedding-0.6B/chat_template.jinja', bytes: 4116, sha256: '87a2728cb8dc9fe424d624542f6060ec05a1d285ebbec578bb078900e33396b5' },
      { path: 'acestep-v15-turbo/config.json', bytes: 1968, sha256: '74745ff704ea49164c3d2d1c99fc0670f3fc635a869f0aec2d1311e6a52d400a' },
      { path: 'config.json', bytes: 1968, sha256: '74745ff704ea49164c3d2d1c99fc0670f3fc635a869f0aec2d1311e6a52d400a' },
      { path: 'acestep-5Hz-lm-1.7B/config.json', bytes: 1385, sha256: '73515ca4bfd86a5b56f28bf680311d1911e159c85d7f7ceb2188e310007c9010' },
      { path: 'Qwen3-Embedding-0.6B/config.json', bytes: 1359, sha256: 'bb23c1607cfe059a58d8f0196cf1cebb52082b1056b8e358a579da80a5759420' },
      { path: 'Qwen3-Embedding-0.6B/added_tokens.json', bytes: 707, sha256: 'c0284b582e14987fbd3d5a2cb2bd139084371ed9acbae488829a1c900833c680' },
      { path: 'Qwen3-Embedding-0.6B/special_tokens_map.json', bytes: 613, sha256: '76862e765266b85aa9459767e33cbaf13970f327a0e88d1c65846c2ddd3a1ecd' },
      { path: 'vae/config.json', bytes: 425, sha256: '14e019904df567f26df750317a70e2bd08f9f8f3c40ff4a24c97d1cd3f20ccd2' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 9625, sizeBytes: 10092095357, vramMB: 8192,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'audio',
    why: 'AI music generation for soundtracks.',
  },
  {
    id: 'upscaler', group: 'Fix',
    friendlyName: 'Upscaler', technical: 'SwinIR x4 (classical)',
    installType: 'file',
    url: 'https://github.com/JingyunLiang/SwinIR/releases/download/v0.0/001_classicalSR_DF2K_s64w8_SwinIR-M_x4.pth',
    fileName: 'swinir_classical_x4.pth', sha256: SWINIR_SHA256,
    sizeMB: 65, sizeBytes: SWINIR_BYTES, vramMB: 2048,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'fix',
    why: 'Sharpen and upscale images 4x.',
  },
  {
    id: 'face-restore', group: 'Fix',
    friendlyName: 'Face Restore', technical: 'GFPGAN v1.4',
    installType: 'file',
    url: 'https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth',
    fileName: 'GFPGANv1.4.pth', sha256: 'e2cd4703ab14f4d01fd1383a8a8b266f9a5833dacee8e6a79d3bf21a1b6be5ad',
    sizeMB: 333, sizeBytes: GFPGAN_BYTES, vramMB: 2048,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'fix',
    why: 'Restore blurry or damaged faces.',
  },
  {
    id: 'vision', group: 'Analyze',
    friendlyName: 'Vision', technical: 'Florence-2 large',
    installType: 'hf', repo: 'microsoft/Florence-2-large',
    commit: '21a599d414c4d928c9032694c424fb94458e3594',
    files: [
      { path: 'model.safetensors', bytes: 1553563458, sha256: '4f38ce741c6b71188fe2b3419a55e11917a8a7b321ae2e63c61da0191b0ebad7' },
      { path: 'tokenizer.json', bytes: 1355863, sha256: '847bbeab6174d66a88898f729d52fa8d355fafe1bea101cf960dd404581df70e' },
      { path: 'vocab.json', bytes: 1099884, sha256: '394fdc63c71aabe0a9b97117f5d62fb5fcc4d59b2b3ea929a3929e6a53217b3c' },
      { path: 'modeling_florence2.py', bytes: 127455, sha256: '5162bf465e61b6e29cc113a467630ec3cb56ed8e4d46eb6207157f10fb9b8a24' },
      { path: 'processing_florence2.py', bytes: 48674, sha256: 'c655782a9e4347965c735ea54cbc4e98fdbc02155ffd1ce2ecd61f42c45eda28' },
      { path: 'configuration_florence2.py', bytes: 15119, sha256: 'de2e45a975b3582de05d2f4d963a3e9f9a3d20dccf78d28e0052932a0be93bdf' },
      { path: 'config.json', bytes: 2445, sha256: '6f8a8f92a74ce18b5c1e5646b4a8222477dd1ac49f31b953e75d6fc3e0f8583a' },
      { path: 'LICENSE', bytes: 1141, sha256: 'c2cfccb812fe482101a8f04597dfc5a9991a6b2748266c47ac91b6a5aae15383' },
      { path: 'preprocessor_config.json', bytes: 806, sha256: '2f5921bbc53c7cc04251e1027b45b1cec726276be6db23d1bb40641bfbe2cf29' },
      { path: 'generation_config.json', bytes: 51, sha256: '30e9865458ecc8ee931eeeb43f44f1d169c5ab95be39e0072142a7a6b8f31990' },
      { path: 'tokenizer_config.json', bytes: 34, sha256: '79ffcf43af8ebda99d165f61d243180da2e2639952e41e71e11611c18770489c' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 1484, sizeBytes: 1556214930, vramMB: 3072,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'analyze',
    why: 'Understand images and video — captions, regions, depth cues.',
  },
  {
    id: 'smart-select', group: 'Edit',
    friendlyName: 'Smart Select', technical: 'SAM 2 (tiny)',
    installType: 'file',
    url: 'https://dl.fbaipublicfiles.com/segment_anything_2/072824/sam2_hiera_tiny.pt',
    fileName: 'sam2_hiera_tiny.pt', sha256: '65b50056e05bcb13694174f51bb6da89c894b57b75ccdf0ba6352c597c5d1125',
    sizeMB: 149, sizeBytes: SAM2_BYTES, vramMB: 2048,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'edit',
    why: 'Click to select any object for editing or removal.',
  },
  {
    id: 'erase', group: 'Edit',
    friendlyName: 'Erase', technical: 'LaMa (via lama-cleaner)',
    installType: 'pip', pipPackage: 'lama-cleaner==1.2.5', installBytes: null,
    installScope: null, firstRunBytes: null,
    unavailable: 'Not available yet: CI-measured (run 39242332869), the Windows pip install pulls CPU-only torch for lama-cleaner==1.2.5, and its in-app invocation is not wired. Withheld until real Windows install + import evidence (WO-8).',
    url: null, fileName: null, sha256: null,
    sizeMB: 200, vramMB: 2048,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'edit',
    why: 'Remove unwanted objects cleanly.',
  },
  {
    id: 'depth-fx', group: 'Analyze',
    friendlyName: 'Depth FX', technical: 'Depth-Anything V2 (small)',
    installType: 'hf', repo: 'depth-anything/Depth-Anything-V2-Small',
    commit: '03876f8651c73a60fe4c2c48294e09fcb6838fcf',
    files: [
      { path: 'depth_anything_v2_vits.pth', bytes: 99218434, sha256: '715fade13be8f229f8a70cc02066f656f2423a59effd0579197bbf57860e1378' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 95, sizeBytes: 99218434, vramMB: 1024,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'analyze',
    why: 'Depth maps for 3D-ish effects and relighting.',
  },
  {
    id: 'pose-lock', group: 'Analyze',
    friendlyName: 'Pose Lock', technical: 'DWPose',
    installType: 'hf', repo: 'yzd-v/DWPose',
    commit: '1a7144101628d69ee7a3768d1ee3a094070dc388',
    files: [
      { path: 'dw-ll_ucoco_384.pth', bytes: 406878486, sha256: '0d9408b13cd863c4e95a149dd31232f88f2a12aa6cf8964ed74d7d97748c7a07' },
      { path: 'dw-ll_ucoco.pth', bytes: 404734742, sha256: 'e9600664e7927229ed594197d552023e3be213f810beb38847a959ec8261e0f7' },
      { path: 'rtm-x_ucoco_384-f5b50679_20230822.pth', bytes: 227246772, sha256: 'f5b506794e8e4facfa6ae0bf2a19c7c43d67836a90b69a19beced4ddb54732b4' },
      { path: 'rtm-x_ucoco_256-05f5bcb7_20230822.pth', bytes: 226726579, sha256: '05f5bcb76599e0e23389a9c21f3390b2aa1a56363b27d844556c3be4b138c536' },
      { path: 'dw-mm_ucoco.pth', bytes: 216812378, sha256: 'b24f27f57d18d8bb7abc3af8e09bcc5f77ee9ecae13439f70a8f7d1b885413cf' },
      { path: 'yolox_l.onnx', bytes: 216746733, sha256: '7860ae79de6c89a3c1eb72ae9a2756c0ccfbe04b7791bb5880afabd97855a411' },
      { path: 'dw-ll_ucoco_384.onnx', bytes: 134399116, sha256: '724f4ff2439ed61afb86fb8a1951ec39c6220682803b4a8bd4f598cd913b1843' },
      { path: 'rtm-l_ucoco_256-95bb32f5_20230822.pth', bytes: 134223626, sha256: '95bb32f5c6ef235a01e5787b33040d5330f7d315afbbefb66832cabe83b6e49b' },
      { path: 'dw-ss_ucoco.pth', bytes: 102933707, sha256: 'c13dfb1dc63aac2d794ac130bb89734330b3c74a1aff921a40fcde1d87361ffc' },
      { path: 'dw-tt_ucoco.pth', bytes: 68475107, sha256: '7097f5af7f100609acffe58eb01734f02ffbfe22794fe029c2ea0a4d68d0f42d' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 2040, sizeBytes: 2139177246, vramMB: 2048,
    license: 'Apache-2.0', licenseNote: 'Free for commercial use.',
    category: 'analyze',
    why: 'Lock a pose across frames for consistent animation.',
  },
  {
    id: 'bg-remove', group: 'Edit',
    friendlyName: 'BG Remove', technical: 'BiRefNet',
    installType: 'hf', repo: 'ZhengPeng7/BiRefNet',
    commit: 'e2bf8e4460fc8fa32bba5ea4d94b3233d367b0e4',
    files: [
      { path: 'model.safetensors', bytes: 444473596, sha256: '9ab37426bf4de0567af6b5d21b16151357149139362e6e8992021b8ce356a154' },
      { path: 'birefnet.py', bytes: 91896, sha256: '208771ae626f653d64128fbf2d6ac9f8e645c5cc5e286258a73ec3322bbfe5ef' },
      { path: 'handler.py', bytes: 4762, sha256: 'b95f5806bfcd575ccff2a9f08816ae0e5d4df1e81b48797f9997f68b531404a5' },
      { path: '.gitignore', bytes: 1908, sha256: '32c2a6d082cb35dcec4af9517742b093e3d4fa7e27208fc0d0cbbdfed859bf19' },
      { path: 'config.json', bytes: 405, sha256: 'c97ea21569daf66b205491a4635147dd3bc42c7c168b89d7d75b53f67ef548ae' },
      { path: 'BiRefNet_config.py', bytes: 298, sha256: 'e7b8c2a74f6cea6a59553d517f71d47f2c1d90e670a13416af17c25fe2f3dc52' },
      { path: 'requirements.txt', bytes: 149, sha256: 'bdfdd83a090d31a2acf64f7350653fa63cd8b5d9d6e0ff3e135bea7ce3786341' },
    ],
    url: null, fileName: null, sha256: null,
    sizeMB: 424, sizeBytes: 444573014, vramMB: 3072,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'edit',
    why: 'Clean background removal.',
  },
  {
    id: 'voice-cleanup', group: 'Audio',
    friendlyName: 'Voice Cleanup', technical: 'DeepFilterNet',
    installType: 'pip', pipPackage: 'deepfilternet==0.5.6', installBytes: null,
    installScope: null, firstRunBytes: null,
    url: null, fileName: null, sha256: null,
    sizeMB: 156, vramMB: 0,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'audio',
    why: 'Remove noise from voice recordings.',
  },
  {
    id: 'slow-motion', group: 'Video',
    friendlyName: 'Slow Motion', technical: 'RIFE (author-hosted)',
    installType: 'adopt',
    adoptUrl: 'https://drive.google.com/drive/folders/1hSzUn10Era3JCaVz0Z5Eg4wT9R6eJ9U9?usp=sharing',
    adoptHint: 'Download the model files from the author\u2019s folder, then point TakeOne at the folder — it copies and checks the files itself. Nothing to move by hand.',
    url: null, fileName: null, sha256: null,
    sizeMB: 50, vramMB: 2048,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'video',
    why: 'Buttery slow motion from regular footage.',
    adoptFiles: ['flownet.pkl'],
  },
  {
    id: 'stem-split', group: 'Audio',
    friendlyName: 'Stem Split', technical: 'Demucs',
    installType: 'pip', pipPackage: 'demucs==4.1.0', installBytes: null,
    installScope: null, firstRunBytes: null,
    url: null, fileName: null, sha256: null,
    sizeMB: 5543, vramMB: 2048,
    license: 'MIT', licenseNote: 'Free for commercial use.',
    category: 'audio',
    why: 'Split music into vocals, drums, bass and more.',
  },
];

/** Dependencies the app installs itself (shown honestly on cards, never phantom).
 *  Keyed by installType. */
const IMPLICIT_DEPS = {
  hf: [{ name: 'huggingface_hub', kind: 'Python helper', sizeMB: 5, note: 'Lets TakeOne fetch model files. Installed once, with your OK.' }],
  pip: [],
  file: [],
  external: [],
  adopt: [],
};

const REQUIRED_FIELDS = ['id', 'group', 'friendlyName', 'technical', 'installType', 'sizeMB', 'vramMB', 'license', 'category', 'why'];

/** Validate the whole catalog. Returns { ok, errors[] }. Pure. */
function validateCatalog(cat) {
  const errors = [];
  const seen = new Set();
  for (const t of cat || []) {
    for (const f of REQUIRED_FIELDS) {
      if (t[f] === undefined || t[f] === null || t[f] === '') errors.push(`${t.id || '?'}: missing ${f}`);
    }
    if (seen.has(t.id)) errors.push(`duplicate id: ${t.id}`);
    seen.add(t.id);
    if (!['file', 'hf', 'pip', 'external', 'adopt'].includes(t.installType)) errors.push(`${t.id}: bad installType`);
    if (t.installType === 'file' && !t.url) errors.push(`${t.id}: file type needs url`);
    if (t.installType === 'hf' && !t.repo) errors.push(`${t.id}: hf type needs repo`);
    if (t.installType === 'pip' && !t.pipPackage) errors.push(`${t.id}: pip type needs pipPackage`);
    // Banned components must never appear (license + #34).
    const blob = JSON.stringify(t).toLowerCase();
    if (blob.includes('l-t-x') || /(^|[^a-z])ltx[^a-z]/.test(blob.replace(/-/g, ''))) errors.push(`${t.id}: banned LTX reference`);
    if (blob.includes('realesrgan')) errors.push(`${t.id}: banned RealESRGAN reference`);
  }
  return { ok: errors.length === 0, errors };
}

/** Gate 2 poka-yoke: can this tool be selected on this PC? Pure. */
function vramAllowed(tool, vramMB) {
  if (!tool) return { ok: false, reason: 'Unknown tool.' };
  if (tool.tier24 && vramMB !== null && vramMB < 24576) {
    return {
      ok: false,
      reason: `Needs 24 GB of VRAM — this PC has ${(vramMB / 1024).toFixed(1)} GB.`,
      whyLink: 'Video Pro is the heaviest engine TakeOne ships. Smaller cards cannot hold its weights in memory, so the download is blocked before it wastes your time and disk.',
    };
  }
  if (vramMB !== null && tool.vramMB > 0 && vramMB < tool.vramMB * 0.8) {
    return {
      ok: false,
      reason: `Likely too heavy — needs about ${(tool.vramMB / 1024).toFixed(1)} GB VRAM, this PC has ${(vramMB / 1024).toFixed(1)} GB.`,
      whyLink: 'TakeOne blocks tools that would fail at render time. You can still try the lighter alternative in the same group.',
    };
  }
  return { ok: true };
}

/** Sum of selected tools' estimated sizes (planning only — real bytes come from the server). */
function estimateBytes(tools) {
  return tools.reduce((s, t) => s + (t.sizeBytes || t.sizeMB * 1024 * 1024), 0);
}

/** Canonical JSON for the tamper-evident signature. */
function canonicalCatalog() {
  return JSON.stringify(CATALOG);
}
function catalogSignature() {
  return crypto.createHash('sha256').update(canonicalCatalog(), 'utf8').digest('hex');
}
/** Verify the catalog hasn't been tampered with. Honest scope: tamper-evident
 *  manifest check, not PKI code-signing (that arrives with the signing cert). */
function verifyCatalog(sha) {
  return sha === catalogSignature();
}

module.exports = {
  CATALOG, IMPLICIT_DEPS, REQUIRED_FIELDS,
  validateCatalog, vramAllowed, estimateBytes,
  canonicalCatalog, catalogSignature, verifyCatalog,
};
