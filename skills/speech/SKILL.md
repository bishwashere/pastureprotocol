---
id: speech
name: Speech
description: Voice-to-text (Whisper) and text-to-voice (11Labs). Use when transcribing audio, converting speech to text, or generating spoken audio from text. Commands: transcribe, synthesize.
---

# Speech

Voice-to-text via **Whisper** (OpenAI) and text-to-voice via **11Labs**. Use when the user wants to transcribe audio, convert speech to text, or generate spoken audio from text.

Call **run_skill** with **skill: "speech"**. Set **command** or **arguments.action** to the operation.

## Commands

- **transcribe** - Voice to text. **arguments.audio** (required): path to audio file (mp3, mp4, mpeg, mpga, m4a, wav, webm; max 25 MB). Optional: **arguments.model** (`whisper-1` or `gpt-4o-transcribe`), **arguments.language** (ISO code, e.g. `en`).
- **synthesize** - Text to voice. **arguments.text** (required): text to speak. **arguments.voiceId** (optional): 11Labs voice ID (default from config or a built-in). Optional: **arguments.outputPath** to save to a file.
- **reply_as_voice** - Send your reply as a voice message. **arguments.text** (required): the exact reply text to speak. Use this when the user asks for a voice reply or when you want to respond with voice (in private or group chat). The reply will be sent as a voice message; you do not need to receive a voice message first.

## Arguments

- **transcribe**: `audio` (required), `model`, `language`
- **synthesize**: `text` (required), `voiceId`, `outputPath`
- **reply_as_voice**: `text` (required) - the reply to speak; the message will be sent as voice

## When to use

- User sends a voice note or audio file and wants a transcript.
- User asks to "transcribe this", "what did they say", or "speech to text".
- User asks to "read this aloud", "turn this into speech", or "text to voice" - use synthesize with the text.
- User asks to "reply in voice", "send a voice message", or "respond with voice" - use **reply_as_voice** with your reply as **arguments.text**. Works in private and group chat; the user does not need to send voice first.

## Voice in, voice out on WhatsApp and Telegram

When the user sends a **voice message**, the bot transcribes it with Whisper and feeds the text to the LLM. The system adds a hint so you reply using **reply_as_voice**; your reply is then sent as a voice message. So voice always goes through the speech skill: transcribe for input, **reply_as_voice** for the reply.

### Voice reply content rules

Voice replies must be **spoken-word friendly**. The listener hears the reply as audio, so:

- **Summarize and respond conversationally** - give the gist, answer the question, or reply naturally
- **Do NOT read out** file names, folder names, long paths, or raw file/code contents
- **Do NOT recite** directory listings, config keys, or technical metadata
- Only mention specific file names or paths if the user **explicitly asked** for them (e.g. "what's the exact file name?")
- When referencing files or code, describe what they do in plain language instead

## Tool schema

```tool-schema
speech_transcribe
  description: Voice to text. Pass path to audio file (mp3, wav, etc.).
  parameters:
    audio: string
    model: string
    language: string

speech_synthesize
  description: Text to voice. Pass text and optional voiceId, outputPath.
  parameters:
    text: string
    voiceId: string
    outputPath: string

speech_reply_as_voice
  description: Send the reply as a voice message. Pass the exact reply text.
  parameters:
    text: string
```

## Config (set at install/setup)

Speech uses a **separate setup** from the LLM cloud provider:

- **Whisper (voice → text):** During setup you can choose to use your existing **OpenAI API key** (e.g. `LLM_1_API_KEY`) or enter a **separate Whisper/OpenAI key** (stored as `SPEECH_WHISPER_API_KEY`). Config: `skills.speech.whisper.apiKey` (env var name).
- **11Labs (text → voice):** During setup you are asked for your **11Labs API key**; it is stored in `.env` as `ELEVEN_LABS_API_KEY`. Config: `skills.speech.elevenLabs.apiKey` (env var name).

Re-run setup to add or change speech keys.
