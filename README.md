# Virouter Prompt Lens

A clean-room Chrome MV3 extension that turns selected images into structured prompts using a user-provided OpenAI-compatible API endpoint.

## Features

- Page-native floating PromptCard-style panel
- Hover image button: **Prompt**
- Right-click image: **Analyze image with Virouter**
- Capture visible tab or drag-select a custom page area
- Setup state inside the page overlay when API key is missing
- Loading, error, result, prompt tabs, and visual history rail
- Tool card to create an image from the generated prompt via `/v1/images/generations` using `gpt-image-2`
- Optional auto-generate image pipeline after prompt analysis
- Smooth fake progress bar during AI vision analysis
- Scroll-anchored hover button for infinite-scroll websites
- Video tool placeholder, ready to wire when a Virouter video endpoint/model is available
- Popup upload analysis
- Prompt tabs: General, Midjourney, SDXL, Flux, DALL·E, JSON, Analysis
- Local-only settings and history
- No bundled third-party backend, billing, or tracking

## Setup

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `virouter-prompt-lens` folder.
5. Open the extension popup and enter:
   - Base URL is prefilled as `https://api.virouter.com/v1`.
   - Virouter API key from the dashboard, e.g. `vr_sk_...`.
   - Vision-capable model name. Default is `gpt-5.4-mini`; change it if your Virouter routing catalog uses a different vision model.

## Notes

- The extension sends only selected/uploaded/captured image data to the configured endpoint.
- API key and history are stored in Chrome local extension storage.
- Use a vision-capable model. Text-only models will return an upstream error.


## License

Licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for details.

Copyright 2026 Virouter.
