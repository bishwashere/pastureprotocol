/**
 * Vision executor: describe or analyze an image using a vision-capable LLM; or generate an image and send to chat.
 * Image: file path (browse screenshot, user upload), URL, data URI, or live webcam.
 * Built-in chaining: screenshot → vision → browse (click/fill/scroll). Live camera: image "webcam" captures from default webcam.
 * Action "generate": create image from prompt and return imageReply so the chat can send it.
 */

import { readFileSync, existsSync } from 'fs';
import { describeImage, generateImage } from '../../llm.js';

function pathToDataUri(filepath) {
  const buf = readFileSync(filepath);
  const ext = (filepath.split('.').pop() || '').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  const base64 = buf.toString('base64');
  return `data:${mime};base64,${base64}`;
}

/**
 * Capture one frame from the default webcam via Playwright (getUserMedia → canvas → data URL).
 * @returns {Promise<string>} data URI (image/jpeg)
 */
async function captureWebcamFrame() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({
      permissions: ['camera'],
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    const dataUrl = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await new Promise((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error('Video failed to load'));
        video.play().catch(reject);
      });
      await new Promise((r) => setTimeout(r, 300));
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0);
      stream.getTracks().forEach((t) => t.stop());
      return canvas.toDataURL('image/jpeg', 0.9);
    });
    await browser.close();
    if (!dataUrl || !dataUrl.startsWith('data:image/')) throw new Error('Webcam capture did not return an image');
    return dataUrl;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * @param {object} ctx - unused
 * @param {object} args - LLM tool args: image (path, URL, "webcam"), source ("webcam"), prompt (optional)
 * @returns {Promise<string>}
 */
/** Get image source from args: image, url, or common aliases (path, file, filePath, imagePath) so LLM can pass path from "Image file: ..." message. */
function getImageFromArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const v = (key) => (args[key] != null && args[key] !== '') ? String(args[key]).trim() : null;
  return v('image') || v('url') || v('path') || v('file') || v('filePath') || v('imagePath') || null;
}

export async function executeVision(ctx, args) {
  const action = (args?.action && String(args.action).trim().toLowerCase()) || 'describe';

  if (action === 'generate') {
    const prompt = (args?.prompt && String(args.prompt).trim()) || '';
    if (!prompt) throw new Error('vision action "generate" requires "prompt" (text description of the image to create).');
    const size = (args?.size && String(args.size).trim()) || '1024x1024';
    const { path: imagePath, caption } = await generateImage(prompt, { size });
    const sendToChat = args?.sendToChat !== false;
    return JSON.stringify({
      imageReply: sendToChat ? { path: imagePath, caption } : null,
      message: sendToChat ? `Generated image saved to ${imagePath}. It will be sent to the chat.` : `Generated image saved to ${imagePath}.`,
      path: imagePath,
      caption,
    });
  }

  const source = (args?.source && String(args.source).trim().toLowerCase()) === 'webcam';
  let image = getImageFromArgs(args);
  if (source || (image && image.toLowerCase() === 'webcam')) {
    image = await captureWebcamFrame();
  }
  if (!image) throw new Error('vision requires "image", "url", or "path" (file path, URL, or data URI), or "source": "webcam" / image: "webcam" for live camera');

  let imageInput;
  if (image.startsWith('http://') || image.startsWith('https://')) {
    imageInput = image;
  } else if (image.startsWith('data:image/')) {
    imageInput = image;
  } else {
    if (!existsSync(image)) throw new Error(`Image file not found: ${image}`);
    imageInput = pathToDataUri(image);
  }

  const prompt = (args?.prompt && String(args.prompt).trim()) || 'Describe what you see in this image. If there is text, read it.';
  const systemPrompt = (args?.systemPrompt && String(args.systemPrompt).trim()) || 'You are a helpful vision assistant. Describe or analyze the image concisely. If the user asked a specific question, answer it.';

  return describeImage(imageInput, prompt, systemPrompt);
}
