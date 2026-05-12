import { z } from 'genkit';

// Tool: verify an eco-action photo using Gemini Vision
export const verifyActionInputSchema = z.object({
  photo_url: z.string().describe('Firebase Storage URL of the action photo'),
  action_type: z.string().describe('Type of eco-action claimed by child'),
  action_description: z.string().describe('Human-readable description of what to look for'),
});

export const verifyActionOutputSchema = z.object({
  verified: z.boolean().describe('Whether the action is confirmed present in the image'),
  confidence: z.number().min(0).max(1).describe('Model confidence score 0.0–1.0'),
  detected_label: z.string().describe('What the model actually detected in the image'),
  reason: z.string().describe('Explanation of the decision, especially for rejections'),
});

// Tool: update garden resources after a verified action
export const updateGardenInputSchema = z.object({
  garden_id: z.string(),
  health_delta: z.number(),
  water_delta: z.number(),
  nutrient_delta: z.number(),
});

// Tool: award energy points to a child
export const rewardChildInputSchema = z.object({
  child_uid: z.string(),
  base_points: z.number(),
  streak_multiplier: z.number().default(1.0),
  action_type: z.string(),
});
