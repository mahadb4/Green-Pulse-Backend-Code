import * as admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ActionType, CVResult } from '../types';
import { ACTION_CONFIG, CV_RESPONSE_TIMEOUT_MS } from '../config/constants';

const CV_PROMPTS: Record<ActionType, string> = {
  recycle_bottle:  'Look for a plastic bottle being placed into or near a recycling bin. Both the bottle AND recycling bin must be clearly visible. Return JSON only.',
  plant_seed:      'Look for a freshly planted seed or small sapling in soil. Soil disturbance or a small plant emerging from ground must be visible. Return JSON only.',
  water_plant:     'Look for a watering can, bottle, or hose actively watering a visible plant. Both the water source and plant must be present. Return JSON only.',
  pick_litter:     'This is a before/after pair. In the before image, litter should be visible. In the after, the same scene should be cleaner. Assess the pair together. Return JSON only.',
  compost_waste:   'Look for food scraps, organic waste, or vegetable matter being placed into a compost bin or compost pile. Return JSON only.',
  turn_off_light:  'Look for a light switch in the OFF position in a clearly unlit room. The room must appear dark/unlit. High false-positive risk — be strict. Return JSON only.',
};

export async function verifyAction(
  photoUrl: string,
  actionType: ActionType
): Promise<CVResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const config = ACTION_CONFIG[actionType];
  const prompt = CV_PROMPTS[actionType];

  // Download image from Firebase Storage
  const bucket = admin.storage().bucket();
  const filePath = decodeURIComponent(photoUrl.split('/o/')[1].split('?')[0]);
  const [imageBuffer] = await bucket.file(filePath).download();
  const base64Image = imageBuffer.toString('base64');

  const genai = new GoogleGenerativeAI(apiKey);
  const model = genai.getGenerativeModel({ model: 'gemini-1.5-flash' });

  const systemPrompt = `
You are a CV verification agent for a children's eco-action app.
Your job: determine if the submitted photo shows the claimed eco-action.
Context: Karachi, Pakistan. Images may show Urdu labels, indoor/outdoor settings, varied lighting.

${prompt}

Respond ONLY with this exact JSON structure, no markdown, no extra text:
{
  "verified": boolean,
  "confidence": number between 0.0 and 1.0,
  "detected_label": "what you actually see in the image",
  "reason": "brief explanation of your decision"
}
`;

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('CV agent timeout')), CV_RESPONSE_TIMEOUT_MS)
  );

  const cvPromise = model.generateContent([
    systemPrompt,
    { inlineData: { data: base64Image, mimeType: 'image/jpeg' } },
  ]);

  const result = await Promise.race([cvPromise, timeoutPromise]);
  const text = result.response.text().trim();

  let parsed: CVResult;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`CV agent returned invalid JSON: ${text}`);
  }

  // Apply confidence threshold
  if (parsed.confidence < config.threshold) {
    parsed.verified = false;
    parsed.reason = `Confidence ${parsed.confidence} below threshold ${config.threshold}`;
  }

  return parsed;
}
