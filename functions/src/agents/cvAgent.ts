import * as admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ActionType, CVResult } from '../types';
import { ACTION_CONFIG, CV_RESPONSE_TIMEOUT_MS } from '../config/constants';

// Fallback chain — each model has a SEPARATE free-tier quota, so we retry the
// next one on 429/5xx/timeout. Ordered capable-first, then high daily-quota.
const CV_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.5-flash'];

const CV_PROMPTS: Record<ActionType, string> = {
  recycle_bottle:  'Look for a PLASTIC drink bottle (e.g. a clear or coloured water/soda PET bottle, with or without its cap). The plastic bottle is itself the recyclable item — a recycling bin is NOT required in the photo. Verify TRUE whenever a plastic bottle is clearly visible. Reject only if there is no plastic bottle (for example a glass, ceramic mug, metal can, or an unrelated object/person). Return JSON only.',
  plant_seed:      'Look for planting activity or a young plant: seeds, a seedling or sapling, disturbed soil, a dug hole, hands planting, or a small plant in soil or a pot. Verify TRUE if any of these are clearly visible. Return JSON only.',
  water_plant:     'Look for a real plant or greenery TOGETHER WITH a water source (watering can, bottle, hose, jug or cup), or a plant that is clearly being watered. Verify TRUE if both a plant and a plausible water source are visible. Return JSON only.',
  pick_litter:     'Look for litter being collected or cleaned up: trash held in a hand or bag, litter gathered for disposal, or (if two images are given) an after scene that is visibly cleaner than the before. Verify TRUE if litter collection is evident. Return JSON only.',
  compost_waste:   'Look for food scraps or organic waste (fruit or vegetable peels, leftovers, garden trimmings) being composted or placed for compost. A compost bin helps but is NOT required. Verify TRUE if organic/food waste is clearly visible. Return JSON only.',
  turn_off_light:  'Look for a light switch in the OFF position, ideally in a dim or unlit room. Verify TRUE if an off light switch is clearly visible. Return JSON only.',
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

  const requestParts = [
    systemPrompt,
    { inlineData: { data: base64Image, mimeType: 'image/jpeg' } },
  ];

  // Each model has its OWN free-tier quota bucket, so a 429 (or transient 5xx /
  // timeout) on one model falls through to the next. Order: capable → high-quota.
  let text = '';
  let lastErr: unknown;
  for (const modelName of CV_MODELS) {
    try {
      const model = genai.getGenerativeModel({ model: modelName });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('CV agent timeout')), CV_RESPONSE_TIMEOUT_MS)
      );
      const result: any = await Promise.race([
        model.generateContent(requestParts as any),
        timeoutPromise,
      ]);
      text = result.response.text().trim();
      if (text) break;
    } catch (err) {
      lastErr = err;
      console.warn(`[cvAgent] model ${modelName} failed: ${err instanceof Error ? err.message : String(err)}`);
      // try the next model in the fallback chain
    }
  }
  if (!text) {
    throw lastErr instanceof Error ? lastErr : new Error('All CV models unavailable');
  }

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
