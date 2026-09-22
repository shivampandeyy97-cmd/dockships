# ⚓ Dockships — All-in-One AdTech & Website Traffic Intelligence Platform

Dockships is a web application combining two tools into a single UI:
1. **sellers.json Crawler & Verification Engine**
2. **Website Traffic Intelligence Tool** (SimilarWeb-style traffic, geo, and acquisition channel analytics).

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- Node.js >= 18
- `pnpm` (or `npm`)

### 2. Environment Setup
Copy the example environment file in `apps/backend`:
```bash
cp apps/backend/.env.example apps/backend/.env
```

#### Free Tier API Keys (Optional)
The system works out-of-the-box using free public endpoints. To extend quotas or add extra providers:
- **SimilarWeb API**: Set `SIMILARWEB_API_KEY` ([Get Free Trial Key](https://www.similarweb.com/corp/developer/))
- **RapidAPI**: Set `RAPIDAPI_KEY` ([RapidAPI Hub](https://rapidapi.com/))
- **Cloudflare Radar**: Set `CLOUDFLARE_API_TOKEN` ([Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens))

---

## 🛠️ Running Locally

### Install Dependencies
```bash
pnpm install
```

### Start Backend Dev Server
```bash
cd apps/backend
pnpm dev
# Server running at http://localhost:4001
```

### Start Frontend Dev Server
```bash
cd apps/frontend
pnpm dev
# Frontend running at http://localhost:5173
```

---

## 📊 Website Traffic Intelligence Architecture

The Traffic Intelligence engine uses a pluggable **`DataProvider`** interface. Data providers are executed in a fall-through chain and partial metrics are combined:

```
[ Domain Request ] → [ 24h SQLite Cache ] → (Hit? Return cached JSON)
                                         ↓ (Miss)
                               ┌─────────────────────────┐
                               │ Composite Data Provider │
                               └────────────┬────────────┘
                                            │
   ┌──────────────────────┬─────────────────┴───────────────┬─────────────────────────┐
   ▼                      ▼                                 ▼                         ▼
[ SimilarWeb Free ]   [ RapidAPI Provider ]         [ Cloudflare Radar ]      [ Google Trends Proxy ]
```

### Fallback Order & Provider Strategy
1. **SimilarWeb Free Data / Trial API**: Returns estimated monthly visits, pageviews, session duration, top country shares, and acquisition channels.
2. **RapidAPI SimilarWeb**: Fallback if `RAPIDAPI_KEY` is present.
3. **Cloudflare Radar API**: Provides domain global rank and top traffic geography.
4. **Google Trends Proxy**: Relative brand interest signal for new/rising domains.
5. **Insufficient Data Fallback**: Displays clear "Unavailable / Insufficient traffic data" card for low-volume domains without crashing or fabricating numbers.

---

## 🧪 Running Unit Tests

Run the DataProvider fallback unit test suite:
```bash
cd apps/backend
./node_modules/.bin/ts-node-dev --transpile-only src/__tests__/trafficProviders.test.ts
```

---

## 📦 Production Deployment

Build static frontend and compile backend:
```bash
pnpm --filter frontend build
pnpm --filter backend build
```
Start backend (serves API and static SPA):
```bash
cd apps/backend
pnpm start
```
