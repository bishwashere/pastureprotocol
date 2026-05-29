---
id: vision
name: Vision
description: Describe or analyze an image, or generate an image and send to chat. Actions: describe (image/url/path/webcam), generate (prompt → image sent to chat). See SKILL.md.
---

# Vision

Read or analyze an image using a **vision-capable LLM**, or **generate an image** from a text prompt and **send it to the chat**. Use when the user sends an image, when you have an image path (e.g. from a browse screenshot), when the user wants to **see through the camera**, or when the user asks to **create/draw/generate an image** ("Draw a sunset", "Generate a logo for …", "Make an image of …").

**Built-in chaining:** Screenshot → auto-describe → act. After a browse **screenshot**, use the returned file path with vision to describe the page; then you can **click**, **fill**, or **scroll** in a follow-up step. The user does not need to say "describe this then click"-you chain screenshot → vision → browse actions as needed.

**Live camera:** Vision can use the **webcam** as input, not just files. Set **arguments.image** to **"webcam"** (or **arguments.source** to **"webcam"**) to capture one frame from the default camera. Use for prompts like "Show me what you see", "What's in the room?", "Describe what's in front of the camera."

**Generate image and send to chat:** Set **arguments.action** to **"generate"** and **arguments.prompt** to a description of the image to create. The image is generated (OpenAI DALL·E), saved, and **sent to the chat** as a photo with an optional caption. Use for "Draw …", "Generate an image of …", "Create a picture of …". Optional: **arguments.size** (e.g. `1024x1024`), **arguments.sendToChat** (default `true`; set to `false` to only save the image and not send it to the chat).

Call **run_skill** with **skill: "vision"**. Set **command** or **arguments.action** to **describe** (default) or **generate**. Arguments:

- **arguments.action** - **"describe"** (default) or **"generate"**. Use **generate** to create an image from text and send it to the chat.
- **arguments.image**, **arguments.url**, or **arguments.path** - **Required for describe** (unless **arguments.source** is **"webcam"**). Pass the image as one of these (all work the same): **image**, **url**, or **path**. Value can be:
  - **"webcam"** - Capture one frame from the default webcam (live camera). Use for "what do you see", "describe the room", etc.
  - A **file path** (e.g. when the message says "Image file: /path/to/file.jpg", use that path as **arguments.image** or **arguments.path**; or browse screenshot under `~/.cowcode/browse-screenshots/`, or user upload under uploads), or
  - An **image URL** (http/https), or
  - A **data URI** (data:image/...;base64,...).
- **arguments.source** - Optional. Set to **"webcam"** to use the live camera instead of **arguments.image**.
- **arguments.prompt** - For **describe**: optional. What to ask about the image (e.g. "What's in this image?", "Read any text visible."). For **generate**: **required**. Text description of the image to create (e.g. "A cozy cabin in the snow at dusk").
- **arguments.size** - Optional. For **generate** only. Image size (e.g. `1024x1024`, `1024x1792`, `1792x1024`). Default: `1024x1024`.
- **arguments.sendToChat** - Optional. For **generate** only. If `true` (default), the generated image is sent to the chat as a photo. Set to `false` to only save the image and return the path in the tool result.
- **arguments.systemPrompt** - Optional. For **describe** only. Override the default system instruction for the vision model.

## When to use Vision

- **User sent an image in chat** - The message will include a file path where the image was saved (e.g. "Image file: /path/to/tg-123-78.jpg"). Call vision with **arguments.image** or **arguments.path** set to that path, and **arguments.prompt** to the user's caption (or "What's in this image?").
- **Follow-up about the same image** (e.g. "re-parse the image", "what was the travel date?") - You do not need to pass an image. The agent automatically uses the **last image path from chat history** when you call vision without **arguments.image**/url/path, so the user can ask to re-parse or get more details without re-uploading. The file must still exist on disk (e.g. from the same session).
- **"Show me what you see" / "What's in the room?"** - Use **arguments.image: "webcam"** (or **arguments.source: "webcam"**) to capture from the webcam and describe the scene.
- **After a browse screenshot** - Screenshot details include a path under `~/.cowcode/browse-screenshots/`. Use vision with that path to describe or analyze the page; then chain with click/fill/scroll as needed. No need for the user to say "describe this then click."
- **Any image URL** - Pass the URL as **arguments.image** or **arguments.url** to have the vision model describe it.
- **"Draw …" / "Generate an image of …" / "Create a picture of …"** - Use **arguments.action: "generate"** and **arguments.prompt** with the description. The image is created and **sent to the chat** automatically.

For **describe**, you must provide an image source (or the agent will use the last image from chat history when available): **arguments.image**, **arguments.url**, or **arguments.path** (file path from "Image file: ..." in the message), or **arguments.source: "webcam"**. For **generate**, you must provide **arguments.prompt**.

## Tool schema

```tool-schema
vision_describe
  description: Describe or analyze an image. Provide image (path, url, or "webcam"), optional prompt.
  parameters:
    image: string
    url: string
    path: string
    prompt: string
    systemPrompt: string

vision_generate
  description: Generate an image from a text prompt and send to chat (DALL·E).
  parameters:
    prompt: string
    size: string
```

## Config (set at install/setup)

- **If your agent model already supports vision** (e.g. GPT-4o, Claude-3): the image is sent to that model with the same API key; no extra key or switch.
- **If your agent is on a text-only model** (e.g. LM Studio local, GPT-3.5, Llama): during setup you can choose a **vision fallback** (OpenAI or Anthropic). When the user sends an image, the agent tries the main models first; if they don’t support vision, it quietly uses the fallback for that call only. Configure once at setup; no mid-run prompts. In config: `skills.vision.fallback` with `provider`, `model`, and `apiKey` (env var name, e.g. `LLM_1_API_KEY`). Same style as `llm.models` and versions chosen in setup.
- **Image generation (generate + send to chat):** Uses OpenAI DALL·E. Either set **skills.vision.imageGeneration.apiKey** in config to an env var name (e.g. `LLM_1_API_KEY`), or use **OpenAI** as the vision fallback-the same key is used for image generation. Optional: **skills.vision.imageGeneration.size**, **skills.vision.imageGeneration.model** (default `dall-e-3`).
