import * as admin from 'firebase-admin';
import { verifyAction } from './cvAgent';
import { computeImageHash } from './imageHash';
import { runRewardAgent } from './rewardAgent';
import { getWatererMultiplier, sendThirstyNotification } from './watererAgent';
import { ActionDocument, ActionType, GardenState } from '../types';
import {
  ACTION_CONFIG,
  WATERER_THRESHOLD,
  GARDEN_STAGE_THRESHOLDS,
  WORLD_STAGE_THRESHOLDS,
  CLEANLINESS_MAX,
  DUPLICATE_SCAN_LIMIT,
} from '../config/constants';
import { GardenStage, WorldStage, WorldPhase } from '../types';

function calculateStage(health: number): GardenStage {
  for (const [stage, range] of Object.entries(GARDEN_STAGE_THRESHOLDS)) {
    if (health >= range.min && health <= range.max) {
      return stage as GardenStage;
    }
  }
  return 'barren';
}

function calculateWorldStage(cleanliness: number): WorldStage {
  for (const [stage, range] of Object.entries(WORLD_STAGE_THRESHOLDS)) {
    if (cleanliness >= range.min && cleanliness <= range.max) {
      return stage as WorldStage;
    }
  }
  return 'wasteland';
}

/**
 * Download the action photo from Storage once. Returns the raw buffer so it can
 * be reused for both perceptual hashing and the CV agent (no double download).
 */
async function downloadPhoto(photoUrl: string): Promise<Buffer> {
  const bucket = admin.storage().bucket();
  const filePath = decodeURIComponent(photoUrl.split('/o/')[1].split('?')[0]);
  const [buffer] = await bucket.file(filePath).download();
  return buffer;
}

/**
 * Has anyone in this garden already submitted this exact image?
 * Compares the new photo's SHA-256 against every prior action's stored hash in
 * the SAME garden (whole-group scope). Returns the matching action's id if a
 * duplicate is found, else null. Runs before the CV call so re-uploads are
 * rejected without spending Gemini quota.
 */
async function findDuplicateInGarden(
  gardenId: string,
  newHash: string,
  selfActionId: string
): Promise<string | null> {
  const db = admin.firestore();
  const snap = await db
    .collection('actions')
    .where('garden_id', '==', gardenId)
    .limit(DUPLICATE_SCAN_LIMIT)
    .get();

  for (const doc of snap.docs) {
    if (doc.id === selfActionId) continue;
    if (doc.data()?.photo_hash === newHash) {
      return doc.id;
    }
  }
  return null;
}

export async function runCoordinator(
  actionId: string,
  action: ActionDocument
): Promise<void> {
  const db = admin.firestore();
  const actionRef = db.collection('actions').doc(actionId);

  try {
    // Step 0: Transactional lock to prevent double execution (Callable vs Trigger race condition)
    let canProceed = false;
    await db.runTransaction(async (tx) => {
      const doc = await tx.get(actionRef);
      if (doc.exists && doc.data()?.status === 'pending') {
        tx.update(actionRef, { status: 'verifying' });
        canProceed = true;
      }
    });

    if (!canProceed) {
      console.log(`[Coordinator] Action ${actionId} is already processing or completed. Skipping.`);
      return;
    }

    // Step 1: Download the photo once and fingerprint it (SHA-256 of the bytes).
    const imageBuffer = await downloadPhoto(action.photo_url);
    const photoHash = computeImageHash(imageBuffer);

    // Step 1a: Duplicate check (whole-garden) — reject re-uploads of the same
    // image before spending any CV quota. Hash persists even after the photo is
    // deleted, so this catches repeats across days.
    if (photoHash) {
      const dupId = await findDuplicateInGarden(action.garden_id, photoHash, actionId);
      if (dupId) {
        await actionRef.update({
          status: 'rejected',
          confidence: 0,
          detected_label: 'duplicate',
          photo_hash: photoHash,
          rejection_reason: 'This photo has already been submitted. Snap a fresh photo of a new eco-action.',
          processed_at: admin.firestore.Timestamp.now(),
        });
        console.log(`[DUPLICATE LOG] Action ${actionId} rejected — matches prior action ${dupId} in garden ${action.garden_id}.`);
        // Remove from queue and clean up the duplicate's photo.
        await db.collection('gardens').doc(action.garden_id).update({
          action_queue: admin.firestore.FieldValue.arrayRemove(actionId),
        }).catch(() => {});
        try {
          const bucket = admin.storage().bucket();
          const filePath = decodeURIComponent(action.photo_url.split('/o/')[1].split('?')[0]);
          await bucket.file(filePath).delete();
        } catch (err) {
          console.error('Duplicate photo deletion failed (non-fatal):', err);
        }
        return;
      }
    }

    // Step 2: Route to CV Agent (reusing the already-downloaded buffer)
    const cvResult = await verifyAction(
      action.photo_url,
      action.action_type as ActionType,
      imageBuffer
    );

    // Step 2a: Update action document with CV result and rejection reason
    await actionRef.update({
      status: cvResult.verified ? 'verified' : 'rejected',
      confidence: cvResult.confidence,
      detected_label: cvResult.detected_label,
      photo_hash: photoHash ?? null,
      rejection_reason: cvResult.verified ? null : cvResult.reason,
      processed_at: admin.firestore.Timestamp.now(),
    });

    console.log(`[CV VALIDATION PIPELINE LOG] Action ${actionId} processed:
    - Uploaded Image: ${action.photo_url}
    - Action Type: ${action.action_type}
    - Predicted Label: ${cvResult.detected_label}
    - Confidence Score: ${cvResult.confidence}
    - Authenticity Score: ${cvResult.authenticity}${cvResult.authenticity_reason ? ` (${cvResult.authenticity_reason})` : ''}
    - Validation Result: ${cvResult.verified ? 'VERIFIED' : 'REJECTED'}
    - Rejection Reason: ${cvResult.verified ? 'N/A' : cvResult.reason}`);

    if (!cvResult.verified) {
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

      // ─── World cleanup progression ──────────────────────────────────────────
      // Verified eco-actions clean the polluted world. waterBoost also rewards
      // water actions during a drought so progress stays dynamic per garden.
      const cleanlinessGain = config.cleanliness * (action.action_type === 'water_plant' ? waterBoost : 1.0);
      const prevCleanliness = garden.cleanliness ?? 0;
      const newCleanliness = Math.min(CLEANLINESS_MAX, prevCleanliness + cleanlinessGain);
      const newWorldStage = calculateWorldStage(newCleanliness);
      // Unlock the city-builder once the world is fully cleaned; never regress out of it.
      const newPhase: WorldPhase =
        newCleanliness >= CLEANLINESS_MAX || garden.phase === 'building' ? 'building' : 'cleanup';

      tx.update(gardenRef, {
        garden_health: newHealth,
        water_level: newWater,
        nutrient_level: newNutrient,
        garden_stage: newStage,
        cleanliness: newCleanliness,
        world_stage: newWorldStage,
        phase: newPhase,
        action_queue: admin.firestore.FieldValue.arrayRemove(actionId),
      });

      console.log(`[WORLD CLEANUP LOG] Garden ${action.garden_id}: cleanliness ${prevCleanliness} → ${newCleanliness} (+${cleanlinessGain}), stage=${newWorldStage}, phase=${newPhase}`);
    });

    // Step 4: Dispatch Reward Agent
    const { pointsAwarded, newStreak } = await runRewardAgent(
      action.child_uid,
      action.action_type as ActionType,
      action.garden_id
    );

    console.log(`[REWARD TRIGGER LOG] Action ${actionId} rewarded:
    - Reward Trigger Reason: Valid AI CV prediction matching action '${action.action_type}'
    - Points Awarded: ${pointsAwarded} (Base: ${config.points}, Water Boost: ${waterBoost}x)
    - New Streak: ${newStreak}`);

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
    const errorMsg = error instanceof Error ? error.message : String(error);
    console.error(`Coordinator error for action ${actionId}:`, error);
    await actionRef.update({
      status: 'rejected',
      rejection_reason: `System processing error: ${errorMsg}`,
      processed_at: admin.firestore.Timestamp.now()
    });
    throw error;
  }
}
