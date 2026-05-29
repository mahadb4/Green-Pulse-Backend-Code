# GreenPulse Backend 🌱 — The Collaborative Carbon Garden

Firebase Cloud Functions backend powering the GreenPulse eco-action verification system. An AI multi-agent pipeline uses **Gemini 1.5 Flash** (Vision) to verify children's eco-action photos, award points, manage a shared virtual garden, and enforce COPPA compliance.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   React Native App                   │
│         (Camera · Garden UI · Zara Character)        │
└────────────┬─────────────────┬───────────────────────┘
             │ Callable Funcs  │ Firestore Listeners
             ▼                 ▼
┌──────────────────────────────────────────────────────┐
│              Firebase Cloud Functions v2             │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │Coordinator│──│ CV Agent │  │   Reward Agent    │  │
│  │  (Brain)  │  │ (Gemini) │  │ (Points/Streaks) │  │
│  └────┬─────┘  └──────────┘  └───────────────────┘  │
│       │                                              │
│  ┌────┴─────┐  ┌──────────────────────────────────┐  │
│  │ Waterer  │  │      Decay Agent (24h Cron)      │  │
│  │  Agent   │  │  (Health/Water/Nutrient decay)   │  │
│  └──────────┘  └──────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
             │                 │
             ▼                 ▼
┌──────────────────┐  ┌────────────────┐
│    Firestore     │  │ Firebase       │
│  (Gardens, Kids, │  │ Storage        │
│   Actions, Logs) │  │ (Action Photos)│
└──────────────────┘  └────────────────┘
```

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 20 |
| Functions | Firebase Cloud Functions v2 | 7.2.5 |
| Admin SDK | firebase-admin | 13.9 |
| AI/CV | Google Gemini 1.5 Flash (Vision) via `@google/generative-ai` | 0.24.1 |
| AI Framework | Genkit (`@genkit-ai/core`, `@genkit-ai/firebase`, `@genkit-ai/google-genai`) | 1.33 |
| Language | TypeScript (compiled to CommonJS, ES2020 target) | 6.x |
| Database | Cloud Firestore | — |
| Storage | Firebase Storage | — |
| Notifications | Firebase Cloud Messaging (FCM) | — |

## Project Structure

```
greenpulse-backend/
├── firebase.json                    ← Firebase services config (emulators, rules, functions)
├── .firebaserc                      ← Project aliases (greenpulse-dev, greenpulse-dev-63b4b)
├── firestore.rules                  ← Firestore security rules (children, gardens, actions, reward_log)
├── storage.rules                    ← Storage security rules (action-photos/{uid}/, 5MB, images only)
├── functions/
│   ├── src/
│   │   ├── index.ts                 ← Cloud Function exports (5 functions)
│   │   ├── agents/
│   │   │   ├── coordinator.ts       ← Main orchestrator: CV → Garden → Reward → Waterer → Cleanup
│   │   │   ├── cvAgent.ts           ← Gemini Vision photo verification with strict prompts
│   │   │   ├── rewardAgent.ts       ← Energy points + streak calculation (transactional)
│   │   │   ├── watererAgent.ts      ← Water level monitoring + "thirsty" push notifications
│   │   │   └── decayAgent.ts        ← Daily decay of garden health/water/nutrients per member
│   │   ├── config/
│   │   │   └── constants.ts         ← Action points, thresholds, decay rates, timeouts
│   │   ├── tools/
│   │   │   └── schemas.ts           ← Genkit Zod schemas for CV verify, garden update, reward
│   │   └── types/
│   │       └── index.ts             ← TypeScript interfaces (GardenState, ChildState, ActionDocument, etc.)
│   ├── .env.example                 ← Environment variable template (GEMINI_API_KEY)
│   ├── package.json                 ← Dependencies and scripts
│   └── tsconfig.json                ← TypeScript compiler config
└── GreenPulse_Backend_Implementation.md  ← Extended technical spec
```

## Cloud Functions (5 exports)

| Function | Type | Region | Description |
|----------|------|--------|-------------|
| `submitAction` | `onCall` (v2) | us-central1 | Receives action submission from app. Validates auth, checks COPPA approval, creates action document, triggers Coordinator asynchronously. 60s timeout. |
| `onActionCreated` | `onDocumentCreated` (v2) | asia-southeast1 | Firestore trigger on `actions/{actionId}`. Backup path that also calls Coordinator if the action is still `pending`. Transactional lock prevents double-processing. |
| `decayAgentScheduled` | `onSchedule` (v2) | us-central1 | Runs every 24 hours (Asia/Karachi timezone). Decays health, water, and nutrients for all gardens. Sends FCM alerts for critically low gardens. |
| `deleteAllData` | `onCall` (v2) | us-central1 | COPPA right-to-erasure endpoint. Deletes: child document, all actions, all reward logs, Storage photos, and Firebase Auth account. 120s timeout. |
| `getGardenState` | `onCall` (v2) | us-central1 | Returns current garden document for server-validated reads. |

## AI Agent Pipeline

### Coordinator (`agents/coordinator.ts`)
The main orchestrator that runs when an action is submitted:

1. **Transactional Lock** — Sets status from `pending` → `verifying` atomically to prevent double-processing (callable vs. trigger race condition)
2. **CV Agent** — Sends photo to Gemini Vision for verification
3. **Action Update** — Writes CV result (verified/rejected, confidence, detected_label) back to action document
4. **Garden Update** — If verified: applies health/water/nutrient deltas from `ACTION_CONFIG`, checks Waterer multiplier for water actions
5. **Reward Agent** — Awards energy points with streak multiplier
6. **Waterer Check** — If water_level < 20, sends "thirsty" push notification to garden members
7. **Photo Cleanup** — Deletes the photo from Firebase Storage (COPPA compliance)

### CV Agent (`agents/cvAgent.ts`)
- Uses **Gemini 1.5 Flash** via `@google/generative-ai`
- Downloads photo from Firebase Storage, converts to base64
- Sends strict system prompt per action type (each has specific visual requirements)
- 4-second timeout (`CV_RESPONSE_TIMEOUT_MS`)
- Applies per-action confidence thresholds (80–90%)
- Returns `{ verified, confidence, detected_label, reason }`

### Reward Agent (`agents/rewardAgent.ts`)
- Runs inside a Firestore transaction on the child document
- Calculates streak: if last action was within 24 hours, streak increments; otherwise resets to 1
- Applies 1.5× multiplier when streak ≥ 3
- Increments `energy_points`, updates `current_streak` and `last_action_at`
- Writes to `reward_log` collection for parent dashboard visibility

### Waterer Agent (`agents/watererAgent.ts`)
- Checks if garden's `water_level` < 20 (threshold)
- Returns 1.5× multiplier for `water_plant` actions when active
- Sends FCM "thirsty" push notification to all garden members via their stored `fcm_token`

### Decay Agent (`agents/decayAgent.ts`)
- Scheduled to run every 24 hours
- For each garden: reduces health, water, and nutrients by per-member rates
- Recalculates `garden_stage` based on new health thresholds
- Sends FCM "sad" push notification for gardens below health threshold (30)

## Data Models

### `children/{uid}`
```typescript
{
  energy_points: number;        // ≥ 0, incremented by Reward Agent
  current_streak: number;       // ≥ 0, reset if gap > 24h
  parent_approved: boolean;     // false until VPC OTP verification
  nickname: string | null;      // alphanumeric, 3–20 chars
  garden_id: string;            // e.g. "garden_{uid}"
  last_action_at: Timestamp;    // used for streak calculation
  fcm_token: string | null;     // for push notifications
}
```

### `gardens/{gardenId}`
```typescript
{
  garden_health: number;        // 0–100
  garden_stage: GardenStage;    // 'barren' | 'seedling' | 'sapling' | 'tree' | 'forest'
  water_level: number;          // 0–100
  nutrient_level: number;       // 0–100
  action_queue: string[];       // pending action IDs
  member_count: number;
  created_at: Timestamp;
}
```

### `actions/{actionId}`
```typescript
{
  child_uid: string;
  garden_id: string;
  action_type: ActionType;      // 6 supported types
  status: ActionStatus;         // 'pending' | 'verifying' | 'verified' | 'approved' | 'rejected' | 'failed'
  confidence: number;           // 0.0–1.0 from Gemini Vision
  detected_label: string;       // what AI actually detected
  photo_url: string;            // deleted from Storage within pipeline
  created_at: Timestamp;
  processed_at: Timestamp | null;
  rejection_reason?: string;    // human-readable reason for rejection
}
```

### `reward_log/{logId}`
```typescript
{
  child_uid: string;
  garden_id: string;
  action_type: string;
  points_awarded: number;
  streak: number;
  multiplier_applied: boolean;
  created_at: Timestamp;
}
```

## Garden Stage Thresholds

| Stage | Health Range |
|-------|-------------|
| Barren | 0–19 |
| Seedling | 20–39 |
| Sapling | 40–59 |
| Tree | 60–79 |
| Forest | 80–100 |

## Supported Eco-Actions

| Action | Points | Health | Water | Nutrient | CV Threshold |
|--------|--------|--------|-------|----------|-------------|
| `recycle_bottle` | 10 | 0 | 0 | +5 | 80% |
| `plant_seed` | 20 | +10 | 0 | 0 | 80% |
| `water_plant` | 6 | 0 | +8 | 0 | 80% |
| `pick_litter` | 15 | +8 | 0 | 0 | 80% |
| `compost_waste` | 18 | 0 | 0 | +10 | 85% |
| `turn_off_light` | 5 | +3 | 0 | 0 | 90% |

## Game Mechanics Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `STREAK_THRESHOLD` | 3 days | Streak ≥ 3 activates 1.5× multiplier |
| `STREAK_MULTIPLIER` | 1.5× | Points bonus for active streaks |
| `STREAK_WINDOW_HOURS` | 24h | Must act within 24h to maintain streak |
| `DECAY_PER_MEMBER` | 1 | Health reduced per garden member per day |
| `WATER_CONSUME_PER_MEMBER` | 2 | Water reduced per member per day |
| `NUTRIENT_CONSUME_PER_MEMBER` | 1 | Nutrients reduced per member per day |
| `WATERER_THRESHOLD` | 20 | Water level below this triggers Waterer agent |
| `WATERER_MULTIPLIER` | 1.5× | Bonus for water actions when Waterer is active |
| `HEALTH_ALERT_THRESHOLD` | 30 | FCM push if health drops below this |
| `CV_RESPONSE_TIMEOUT_MS` | 4000 | 4-second SLA for Gemini Vision response |

## Firestore Security Rules

- **children/{uid}**: Full read/write for own document. Any authenticated user can read (for nickname uniqueness queries). Admin SDK bypasses rules.
- **gardens/{gardenId}**: Any authenticated user can read/write.
- **actions/{actionId}**: Create only with own `child_uid` and status `pending`/`rejected`. Read/update own actions. Delete only via Admin SDK.
- **reward_log/{logId}**: Read own entries. Write allowed for all authenticated (simulation fallback). Delete only via Admin SDK.

## Storage Security Rules

- Path: `action-photos/{uid}/{photoId}`
- Write: authenticated, UID must match, < 5MB, image MIME type only
- Read: only own UID

## Emulators

| Service | Port |
|---------|------|
| Auth | 9099 |
| Firestore | 8080 |
| Functions | 5002 |
| Storage | 9199 |
| Emulator UI | 4001 |

All emulators bind to `0.0.0.0` for LAN access.

## Getting Started

### Prerequisites
- Node.js 20
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project on the Blaze plan
- Gemini API key from [AI Studio](https://aistudio.google.com)

### Setup

```bash
# Install dependencies
cd functions
npm install

# Set up environment variables
cp .env.example .env
# Edit .env and add: GEMINI_API_KEY=your_key_here

# Build TypeScript
npm run build

# Run locally with emulators
firebase emulators:start

# Deploy to Firebase
firebase deploy --only functions
firebase deploy --only firestore:rules,storage
```

### Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `build` | `tsc` | Compile TypeScript to `lib/` |
| `build:watch` | `tsc --watch` | Watch mode compilation |
| `serve` | build + emulators | Build and start function emulators |
| `deploy` | `firebase deploy --only functions` | Deploy to production |
| `lint` | `tsc --noEmit` | Type-check without emitting |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key for Vision CV agent | ✅ |

## Security & COPPA Compliance

- **No PII Collected**: Children use nicknames, not real names, in the app's public-facing features
- **Anonymous Auth Fallback**: Anonymous sign-in available as backup
- **Photo Privacy**: Action photos are deleted from Firebase Storage immediately after AI verification
- **Full Data Deletion**: `deleteAllData` callable removes all Firestore docs, Storage files, and Auth account
- **Parent Approval**: Actions cannot be submitted until `parent_approved === true` (OTP-verified)
- **Firestore Rules**: Users can only read/write their own data; delete operations restricted to Admin SDK

## License

This project is part of an academic submission. All rights reserved.
