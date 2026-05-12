import * as admin from 'firebase-admin';
import { ChildState, ActionType } from '../types';
import { ACTION_CONFIG, STREAK_THRESHOLD, STREAK_MULTIPLIER, STREAK_WINDOW_HOURS } from '../config/constants';

export async function runRewardAgent(
  childUid: string,
  actionType: ActionType,
  gardenId: string
): Promise<{ pointsAwarded: number; newStreak: number }> {
  const db = admin.firestore();
  const childRef = db.collection('children').doc(childUid);

  return db.runTransaction(async (tx) => {
    const childSnap = await tx.get(childRef);
    if (!childSnap.exists) throw new Error(`Child ${childUid} not found`);

    const child = childSnap.data() as ChildState;
    const config = ACTION_CONFIG[actionType];
    const now = admin.firestore.Timestamp.now();

    // Calculate streak
    let newStreak = 1;
    if (child.last_action_at) {
      const hoursSinceLastAction =
        (now.toMillis() - child.last_action_at.toMillis()) / (1000 * 60 * 60);
      if (hoursSinceLastAction <= STREAK_WINDOW_HOURS) {
        newStreak = child.current_streak + 1;
      }
    }

    // Apply streak multiplier
    const multiplier = newStreak >= STREAK_THRESHOLD ? STREAK_MULTIPLIER : 1.0;
    const pointsAwarded = Math.round(config.points * multiplier);

    tx.update(childRef, {
      energy_points: admin.firestore.FieldValue.increment(pointsAwarded),
      current_streak: newStreak,
      last_action_at: now,
    });

    // Log reward event for parent dashboard
    const rewardLogRef = db.collection('reward_log').doc();
    tx.set(rewardLogRef, {
      child_uid: childUid,
      garden_id: gardenId,
      action_type: actionType,
      points_awarded: pointsAwarded,
      streak: newStreak,
      multiplier_applied: multiplier > 1.0,
      created_at: now,
    });

    return { pointsAwarded, newStreak };
  });
}
