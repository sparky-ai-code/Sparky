# Third-Party Notices

## vscode-icons

The custom file icon symbols in `src/pierre-icons.ts` are adapted from the
[`vscode-icons`](https://github.com/vscode-icons/vscode-icons) project.

Copyright (c) 2016 Roberto Huertas

Licensed under the MIT License. The full license text is available in the
upstream repository: <https://github.com/vscode-icons/vscode-icons/blob/master/LICENSE>.

## Hugeicons

The core app chrome and composer glyphs use the free Hugeicons set
[`@hugeicons/core-free-icons`](https://github.com/hugeicons/hugeicons).

Copyright (c) 2025 Hugeicons. Licensed under the MIT License. The full license
text is available at <https://github.com/hugeicons/hugeicons/blob/main/LICENSE.md>.

## Cua Driver

The Windows installer bundles Cua Driver (`cua-driver-rs` v0.56.4) so computer use
works without a separate install. The release archive is checked against its pinned
SHA-256 at build time.

- Project: <https://github.com/trycua/cua/tree/main/libs/cua-driver>
- License: MIT (<https://github.com/trycua/cua/blob/main/LICENSE.md>)

## Kitten TTS (voice replies)

Spoken replies use the English **nano** model of Kitten TTS by KittenML
(<https://github.com/KittenML/KittenTTS>, model card
<https://huggingface.co/KittenML/kitten-tts-2-nano>). The model weights and the
pronunciation lexicon are bundled into the app at build time from a pinned revision of
that model repository, and run on this device. The app also contains a TypeScript port of
KittenTTS's English text normalisation (`src/voice/kitten/kittenNormalize.ts`, from
`kittentts2_tiny/frontend/tts_norm.py`) and of its English word lookup
(`src/voice/kitten/kittenLexicon.ts`, from [misaki](https://github.com/hexgrad/misaki)).

Kitten TTS and misaki are licensed under the Apache License, Version 2.0
(<https://www.apache.org/licenses/LICENSE-2.0>). The full license text is available
in the upstream repositories linked above.

Pronunciations come from the CMU Pronouncing Dictionary (CMUdict) as converted by
KittenML, distributed by Carnegie Mellon University under a BSD-style license.

## ONNX Runtime Web

The Kitten TTS and Whisper models run with ONNX Runtime Web 1.22.0-dev.20250409, bundled
(<https://github.com/microsoft/onnxruntime>). Copyright (c) Microsoft Corporation.
Licensed under the MIT License.

## Whisper speech recognition (voice input)

Voice input transcribes speech on this device with Whisper tiny.en
(<https://huggingface.co/onnx-community/whisper-tiny.en>), a conversion of OpenAI's
Whisper (MIT License), run with Transformers.js 3.8.1
(<https://github.com/huggingface/transformers.js>, Apache License 2.0).
