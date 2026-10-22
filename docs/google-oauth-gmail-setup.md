# Google OAuth 2.0 & Gmail Integration Setup Guide

## Overview

**Swaniki New Business Radar** features enterprise authentication and mailbox management via two distinct, decoupled OAuth 2.0 flows:

1. **Google Sign-In (OpenID Connect)**: Used strictly for user identity verification and role-based session establishment.
2. **Gmail API Integration (Mailbox Connection)**: An explicit, decoupled authorization flow that grants mailbox access (`https://www.googleapis.com/auth/gmail.modify`) for sending grounded outreach and synchronizing threads. Tokens are encrypted using AES-256-GCM authenticated encryption before persisting in MongoDB.

---

## 1. Google Cloud Console Configuration

### Step 1: Create or Select a Google Cloud Project
1. Navigate to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (e.g., `Swaniki Business Radar`) or select your existing project.

### Step 2: Configure OAuth Consent Screen
1. In the left navigation, go to **APIs & Services** > **OAuth consent screen**.
2. Select **External** (or **Internal** for Google Workspace organizations) and click **Create**.
3. Fill in the required fields:
   - **App name**: `Swaniki New Business Radar`
   - **User support email**: Your admin email address
   - **Developer contact information**: Your contact email
4. Click **Save and Continue**.

### Step 3: Configure Scopes
Add the following scopes:
- **Sign-In Scopes (OpenID Connect)**:
  - `openid`
  - `https://www.googleapis.com/auth/userinfo.email`
  - `https://www.googleapis.com/auth/userinfo.profile`
- **Gmail Integration Scopes (Sensitive)**:
  - `https://www.googleapis.com/auth/gmail.modify`

> **Note on Verification**: For internal testing or while in "Testing" publishing status, you can add up to 100 test users in the **Test Users** section. For public production rollouts, Google requires sensitive scope verification for `gmail.modify`.

### Step 4: Create OAuth 2.0 Client ID Credentials
1. Go to **APIs & Services** > **Credentials**.
2. Click **+ Create Credentials** > **OAuth client ID**.
3. Select **Application type**: **Web application**.
4. Set **Name**: `Swaniki Radar Web Client`.
5. Under **Authorized JavaScript origins**, add:
   - `http://localhost:5173`
   - `http://localhost:5000`
   - (Your production domains when deployed)
6. Under **Authorized redirect URIs**, add both decoupled callback endpoints:
   - For Google Sign-In: `http://localhost:5000/api/v1/auth/google/callback`
   - For Gmail API Mailbox: `http://localhost:5000/api/v1/integrations/google/gmail/callback`
7. Click **Create** and copy your **Client ID** and **Client Secret**.

### Step 5: Enable APIs
1. Go to **APIs & Services** > **Library**.
2. Search for and enable:
   - **Gmail API**
   - **Google People API** (or Google OpenID Connect)

---

## 2. Environment Variables Configuration

Copy `backend/.env.example` to `backend/.env` and update the following settings:

```env
# Server & Frontend URLs
PORT=5000
NODE_ENV=development
CLIENT_URL=http://localhost:5173
FRONTEND_URL=http://localhost:5173
BACKEND_URL=http://localhost:5000

# MongoDB URI (Falls back to embedded in-memory MongoDB if external server is offline)
MONGODB_URI=mongodb://localhost:27017/swaniki_radar

# Session & Token Encryption Keys (Must be secure in production!)
SESSION_SECRET=swaniki-session-secret-key-32-chars-long-min!
OAUTH_TOKEN_ENCRYPTION_KEY=dev-oauth-token-aes-encryption-key-32-bytes!

# Google OAuth 2.0 Credentials (From Google Cloud Console)
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
GOOGLE_AUTH_REDIRECT_URI=http://localhost:5000/api/v1/auth/google/callback
GOOGLE_GMAIL_REDIRECT_URI=http://localhost:5000/api/v1/integrations/google/gmail/callback

# Daily Mailbox Outbound Quota
EMAIL_DAILY_SEND_LIMIT=100
```

---

## 3. Architecture & Security Controls

### Decoupled Authentication vs Mailbox Authorization
- **Google Sign-In** strictly queries identity claims (`sub`, `email`, `name`, `picture`). It does not request or store Gmail access tokens.
- **Gmail Connection** is triggered separately from the Email Workspace or Integrations tab. It requests `access_type=offline` and `prompt=consent` to acquire a durable refresh token.

### AES-256-GCM Token Encryption
- Refresh tokens and access tokens are never stored in plaintext in MongoDB.
- Every token is encrypted with AES-256-GCM using a cryptographically random 12-byte initialization vector (IV) and a 16-byte authentication tag (`iv:ciphertext:tag`).
- No OAuth tokens are returned to the React frontend or stored in browser `localStorage`.

### Server-Managed Sessions
- Login issues an `HttpOnly`, `Secure` (in production), `SameSite=lax` cookie named `swaniki_session`.
- Includes session rotation on authentication to prevent session fixation.
- Cryptographic state parameter verification prevents OAuth CSRF attacks.

### 7-Check Pre-Flight Outbound Pipeline
Before any email is dispatched via Gmail:
1. **Idempotency Check**: Unique transaction key prevents duplicate sends.
2. **Approval Verification**: Draft status must be explicitly human-approved.
3. **Recipient Validation**: Format and DNS checks.
4. **Suppression List Check**: Verifies recipient against unsubscribe/opt-out registry.
5. **Mailbox Status & Pause Switch**: Ensures account is connected and not paused.
6. **Daily Send Quota**: Enforces outbound volume caps.
7. **Thread Context**: Formats RFC 2822 messages with `In-Reply-To` and `References` headers when replying.

---

## 4. Local Development Sandbox

When evaluating locally without configured Google Cloud credentials:
- Use **Quick Dev Login (Local Sandbox)** on `/login` to instantly create an authenticated session.
- The system automatically provides an embedded in-memory MongoDB if local `mongod` is not running.
- The simulated mock email provider (`outreach@swaniki.dev`) allows safe local testing without sending real emails.
