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
  const model = genai.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const systemPrompt = `
You are a strict, objective computer vision verification agent for a children's eco-action app.
Your only job: determine if the submitted photo VERIFIABLY shows the claimed eco-action.

CRITICAL INSTRUCTIONS:
1. DO NOT GUESS OR ASSUME. If the required objects are not clearly visible, you MUST reject it.
2. If the image shows an unrelated object (e.g., a laptop, phone screen, random room, person's face, or a ball), you MUST set "verified": false and "confidence": 0.0.
3. You are defending against users uploading random photos to get free points. Be highly skeptical.

Target Action to Verify:
${prompt}

Respond ONLY with this exact JSON structure, no markdown, no extra text:
{
  "verified": boolean,
  "confidence": number between 0.0 and 1.0 (use 0.0 if completely unrelated),
  "detected_label": "what you actually see in the image (e.g., 'A laptop screen', 'A plastic bottle')",
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
    // Strip markdown JSON wrappers if Gemini generated them
    let cleanText = text;
    if (cleanText.startsWith('```json')) {
      cleanText = cleanText.slice(7);
    } else if (cleanText.startsWith('```')) {
      cleanText = cleanText.slice(3);
    }
    if (cleanText.endsWith('```')) {
      cleanText = cleanText.slice(0, -3);
    }
    cleanText = cleanText.trim();

    parsed = JSON.parse(cleanText);
  } catch (err) {
    console.error(`[cvAgent] JSON Parse Error. Raw response: "${text}"`, err);
    parsed = {
      verified: false,
      confidence: 0.0,
      detected_label: 'unrecognized',
      reason: 'AI returned invalid JSON response format.'
    };
  }

  // Handle empty/null/invalid response structure
  if (!parsed || typeof parsed.verified !== 'boolean' || typeof parsed.confidence !== 'number') {
    parsed = {
      verified: false,
      confidence: 0.0,
      detected_label: parsed?.detected_label || 'unrecognized',
      reason: 'AI returned empty, null, or invalid response format.'
    };
  }

  // Apply strict confidence threshold
  if (parsed.verified && parsed.confidence < config.threshold) {
    parsed.verified = false;
    parsed.reason = `Low confidence detection: ${parsed.confidence} is below strict threshold of ${config.threshold}`;
  }

  return parsed;
}
