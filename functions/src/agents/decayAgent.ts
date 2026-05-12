import * as admin from 'firebase-admin';
import {
  DECAY_PER_MEMBER,
  WATER_CONSUME_PER_MEMBER,
  NUTRIENT_CONSUME_PER_MEMBER,
  HEALTH_ALERT_THRESHOLD,
} from '../config/constants';
import { GardenState, GardenStage } from '../types';
import { GARDEN_STAGE_THRESHOLDS } from '../config/constants';

function calculateStage(health: number): GardenStage {
  for (const [stage, range] of Object.entries(GARDEN_STAGE_THRESHOLDS)) {
    if (health >= range.min && health <= range.max) {
      return stage as GardenStage;
    }
  }
  return 'barren';
}

export async function runDecayAgent(): Promise<void> {
  const db = admin.firestore();
  const messaging = admin.messaging();
  const gardens = await db.collection('gardens').get();
  const batch = db.batch();
  const alertGardens: { gardenId: string; health: number }[] = [];

  gardens.forEach(doc => {
    const garden = doc.data() as GardenState;
    const { member_count, garden_health, water_level, nutrient_level } = garden;

    const newHealth = Math.max(0, garden_health - (DECAY_PER_MEMBER * member_count));
    const newWater = Math.max(0, water_level - (WATER_CONSUME_PER_MEMBER * member_count));
    const newNutrient = Math.max(0, nutrient_level - (NUTRIENT_CONSUME_PER_MEMBER * member_count));
    const newStage = calculateStage(newHealth);

    batch.update(doc.ref, {
      garden_health: newHealth,
      water_level: newWater,
      nutrient_level: newNutrient,
      garden_stage: newStage,
    });

    if (newHealth < HEALTH_ALERT_THRESHOLD) {
      alertGardens.push({ gardenId: doc.id, health: newHealth });
    }
  });

  await batch.commit();

  // Send push notifications for gardens in critical health
  for (const { gardenId } of alertGardens) {
    const children = await db.collection('children')
      .where('garden_id', '==', gardenId)
      .get();

    const tokens: string[] = [];
    children.forEach(doc => {
      const { fcm_token } = doc.data();
      if (fcm_token) tokens.push(fcm_token);
    });

    if (tokens.length === 0) continue;

    await messaging.sendEachForMulticast({
      tokens,
      notification: {
        title: '🌧️ Zara is sad!',
        body: 'Your garden needs help! Take an eco-action to save it.',
      },
      data: {
        type: 'zara_state',
        zara_state: 'sad',
        garden_id: gardenId,
      },
    });
  }
}
