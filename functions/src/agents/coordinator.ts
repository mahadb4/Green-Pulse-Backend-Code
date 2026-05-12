import * as admin from 'firebase-admin';
import { verifyAction } from './cvAgent';
import { runRewardAgent } from './rewardAgent';
import { getWatererMultiplier, sendThirstyNotification } from './watererAgent';
import { ActionDocument, ActionType, GardenState } from '../types';
import { ACTION_CONFIG, WATERER_THRESHOLD, GARDEN_STAGE_THRESHOLDS } from '../config/constants';
import { GardenStage } from '../types';

function calculateStage(health: number): GardenStage {
  for (const [stage, range] of Object.entries(GARDEN_STAGE_THRESHOLDS)) {
    if (health >= range.min && health <= range.max) {
      return stage as GardenStage;
    }
  }
  return 'barren';
}

export async function runCoordinator(
  actionId: string,
  action: ActionDocument
): Promise<void> {
  const db = admin.firestore();
  const actionRef = db.collection('actions').doc(actionId);

  try {
    // Step 1: Route to CV Agent
    const cvResult = await verifyAction(action.photo_url, action.action_type as ActionType);

    // Step 2: Update action document with CV result
    await actionRef.update({
      status: cvResult.verified ? 'verified' : 'rejected',
      confidence: cvResult.confidence,
      detected_label: cvResult.detected_label,
      processed_at: admin.firestore.Timestamp.now(),
    });

    if (!cvResult.verified) {
      console.log(`Action ${actionId} rejected: ${cvResult.reason}`);
      return;
    }

    // Step 3: Verified — update garden resources
    const config = ACTION_CONFIG[action.action_type as ActionType];
    const gardenRef = db.collection('gardens').doc(action.garden_id);

    // Check if Waterer agent should boost water actions
    const watererMultiplier = await getWatererMultiplier(action.garden_id);
    const waterBoost = action.action_type === 'water_plant' ? watererMultiplier : 1.0;

    await db.runTransaction(async (tx) => {
      const gardenSnap = await tx.get(gardenRef);
      if (!gardenSnap.exists) throw new Error(`Garden ${action.garden_id} not found`);

      const garden = gardenSnap.data() as GardenState;

      const newHealth = Math.min(100, garden.garden_health + config.health);
      const newWater = Math.min(100, garden.water_level + (config.water * waterBoost));
      const newNutrient = Math.min(100, garden.nutrient_level + config.nutrient);
      const newStage = calculateStage(newHealth);

      tx.update(gardenRef, {
        garden_health: newHealth,
        water_level: newWater,
        nutrient_level: newNutrient,
        garden_stage: newStage,
        action_queue: admin.firestore.FieldValue.arrayRemove(actionId),
      });
    });

    // Step 4: Dispatch Reward Agent
    const { pointsAwarded, newStreak } = await runRewardAgent(
      action.child_uid,
      action.action_type as ActionType,
      action.garden_id
    );

    console.log(`Coordinator: Action ${actionId} verified. +${pointsAwarded} pts, streak: ${newStreak}`);

    // Step 5: Check if Waterer notification needed
    const gardenSnap = await gardenRef.get();
    const garden = gardenSnap.data() as GardenState;
    if (garden.water_level < WATERER_THRESHOLD) {
      await sendThirstyNotification(action.garden_id);
    }

    // Step 6: Delete photo from Storage (COPPA compliance)
    try {
      const bucket = admin.storage().bucket();
      const filePath = decodeURIComponent(action.photo_url.split('/o/')[1].split('?')[0]);
      await bucket.file(filePath).delete();
    } catch (err) {
      console.error('Photo deletion failed (non-fatal):', err);
    }

  } catch (error) {
    console.error(`Coordinator error for action ${actionId}:`, error);
    await actionRef.update({ status: 'rejected', processed_at: admin.firestore.Timestamp.now() });
    throw error;
  }
}
