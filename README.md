# GreenPulse 🌱 — The Collaborative Carbon Garden

A gamified mobile app where children photograph real-world eco-actions. An AI multi-agent system verifies photos using Gemini Vision and updates a shared virtual garden.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   React Native App                   │
│         (Camera · Garden UI · Zara Character)        │
└────────────┬─────────────────┬───────────────────────┘
             │ Callable Funcs  │ Firestore Listeners
             ▼                 ▼
┌──────────────────────────────────────────────────────┐
│              Firebase Cloud Functions                │
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

| Layer | Technology |
|-------|-----------|
| **Frontend** | React Native |
| **Backend** | Firebase Cloud Functions (TypeScript) |
| **AI/CV** | Google Gemini 1.5 Flash (Vision) |
| **Database** | Cloud Firestore |
| **Storage** | Firebase Storage |
| **Auth** | Firebase Anonymous Auth |
| **Notifications** | Firebase Cloud Messaging (FCM) |

## Project Structure

```
greenpulse/
├── functions/                    ← Backend (this repo)
│   ├── src/
│   │   ├── index.ts             ← Cloud Function exports
│   │   ├── agents/
│   │   │   ├── coordinator.ts   ← Main orchestrator
│   │   │   ├── cvAgent.ts       ← Gemini Vision verification
│   │   │   ├── rewardAgent.ts   ← Points & streak logic
│   │   │   ├── watererAgent.ts  ← Water level management
│   │   │   └── decayAgent.ts    ← 24h scheduled health decay
│   │   ├── config/
│   │   │   └── constants.ts     ← Thresholds, point values
│   │   ├── tools/
│   │   │   └── schemas.ts       ← Genkit tool schemas
│   │   └── types/
│   │       └── index.ts         ← TypeScript interfaces
│   ├── .env.example             ← Environment variable template
│   ├── package.json
│   └── tsconfig.json
├── firestore.rules              ← Firestore security rules
├── storage.rules                ← Storage security rules
├── firebase.json                ← Firebase configuration
└── .firebaserc                  ← Firebase project aliases
```

## Getting Started

### Prerequisites

- Node.js >= 18
- Firebase CLI: `npm install -g firebase-tools`
- A Firebase project on the Blaze plan

### Setup

```bash
# Clone the repo
git clone https://github.com/YOUR_USERNAME/greenpulse.git
cd greenpulse

# Install dependencies
cd functions
npm install

# Set up environment variables
cp .env.example .env
# Edit .env and add your Gemini API key

# Build
npm run build

# Run locally with emulators
firebase emulators:start --only functions,firestore,storage

# Deploy to Firebase
firebase deploy --only functions
firebase deploy --only firestore:rules,storage
```

## Cloud Functions

| Function | Type | Description |
|----------|------|-------------|
| `submitAction` | Callable | Submit an eco-action photo for AI verification |
| `onActionCreated` | Firestore Trigger | Backup trigger for action processing |
| `decayAgentScheduled` | Scheduled (24h) | Reduces garden health/water/nutrients daily |
| `deleteAllData` | Callable | COPPA-compliant full data deletion |
| `getGardenState` | Callable | Fetch current garden state |

## AI Agents

| Agent | Role |
|-------|------|
| **Coordinator** | Orchestrates the verification pipeline |
| **CV Agent** | Uses Gemini Vision to verify eco-action photos |
| **Reward Agent** | Awards energy points with streak multipliers |
| **Waterer Agent** | Monitors water levels, triggers notifications |
| **Decay Agent** | Daily decay of garden health based on member count |

## Supported Eco-Actions

| Action | Points | Confidence Threshold |
|--------|--------|---------------------|
| Recycle Bottle | 10 | 80% |
| Plant Seed | 20 | 80% |
| Water Plant | 6 | 80% |
| Pick Litter | 15 | 80% |
| Compost Waste | 18 | 85% |
| Turn Off Light | 5 | 90% |

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `GEMINI_API_KEY` | Google Gemini API key from [AI Studio](https://aistudio.google.com) | ✅ |

## Documentation

- [Backend Implementation Guide](./GreenPulse_Backend_Implementation.md) — Full technical spec
- [Frontend Integration Guide](./GreenPulse_Frontend_Integration_Guide.md) — React Native integration docs

## Security

- **COPPA Compliant**: No PII collected, anonymous auth, full data deletion available
- **Photo Privacy**: Action photos are deleted from Storage after AI verification
- **Firestore Rules**: Users can only read/write their own data
- **Storage Rules**: 5MB limit, images only, user-scoped folders

## License

This project is part of an academic submission. All rights reserved.
