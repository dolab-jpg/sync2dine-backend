import { toFile } from 'openai';
import type OpenAI from 'openai';

export interface AiRenderBody {
  image?: string;
  prompt?: string;
  tradeId?: string;
}

/**
 * Edit an uploaded room photo into a photorealistic redesign via OpenAI Images.
 */
export async function handleAiRender(
  body: AiRenderBody,
  openai: OpenAI
): Promise<{ image: string }> {
  const imageDataUrl = String(body.image ?? '').trim();
  const prompt = String(body.prompt ?? '').trim();

  if (!imageDataUrl.startsWith('data:image/')) {
    throw new Error('image must be a data URL (data:image/...)');
  }
  if (!prompt) {
    throw new Error('prompt is required');
  }

  const match = imageDataUrl.match(/^data:(image\/[\w+.-]+);base64,(.+)$/s);
  if (!match) {
    throw new Error('Invalid image data URL');
  }

  const mime = match[1];
  const b64 = match[2];
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) {
    throw new Error('Empty image data');
  }
  if (buffer.length > 25 * 1024 * 1024) {
    throw new Error('Image exceeds 25MB limit');
  }

  const ext =
    mime.includes('jpeg') || mime.includes('jpg') ? 'jpg'
    : mime.includes('webp') ? 'webp'
    : 'png';

  const file = await toFile(buffer, `source.${ext}`, { type: mime });

  const result = await openai.images.edit({
    model: 'gpt-image-1',
    image: file,
    prompt,
    size: '1024x1024',
    quality: 'medium',
  });

  const outB64 = result.data?.[0]?.b64_json;
  if (!outB64) {
    throw new Error('OpenAI returned no image data');
  }

  return { image: `data:image/png;base64,${outB64}` };
}
