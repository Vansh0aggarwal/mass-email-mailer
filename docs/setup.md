# Swaniki New Business Radar — Setup & Operational Runbook

## 1. Prerequisites
- **Node.js:** v20+ or v24+
- **npm:** v10+ or v11+
- **MongoDB:** Local `mongod` service, MongoDB Atlas URI, or Docker.
  *(Note: In local development and automated testing, if an external MongoDB instance is unreachable, an embedded MongoMemoryServer will start automatically, allowing out-of-the-box operation!)*

---

## 2. Installation & Quick Start

1. **Install all dependencies across workspaces:**
   ```bash
   npm install
   ```

2. **Configure Environment Variables:**
   ```bash
   # Backend config
   cp backend/.env.example backend/.env
   ```

3. **Start Development Servers:**
   - Run both backend and frontend concurrently:
     ```bash
     npm run dev
     ```
   - Or start individually:
     ```bash
     npm run dev:backend   # API server on http://localhost:5000
     npm run dev:frontend  # React Vite app on http://localhost:5173
     ```

4. **Open Application:**
   Visit `http://localhost:5173` in your browser.

---

## 3. Running Automated Tests & Verification

- **Run all automated test suites:**
  ```bash
  npm test --workspace=backend
  ```
- **Run TypeScript compilation check:**
  ```bash
  npm run build
  ```

---

## 4. Production Deployment Build
1. Build both workspaces:
   ```bash
   npm run build
   ```
2. Start the production backend server:
   ```bash
   npm run start --workspace=backend
   ```
   *(Or serve the `frontend/dist` directory via NGINX / Caddy / Cloudflare Pages).*
