# Offline-First Synced Notepad

A lightweight, Windows 11-style notepad with tabs, instant auto-save, and cross-device sync via Firebase. Built offline-first so you can write without an internet connection on both PC and mobile.

## Features
- **Offline-First**: Powered by Dexie.js (IndexedDB). Works perfectly without Wi-Fi.
- **Cross-Device Sync**: Uses Firebase Firestore to securely sync notes to your Google account.
- **Tabs**: Windows 11 Notepad style tab management.
- **Progressive Web App (PWA)**: Installable directly to your phone or desktop.
- **Desktop Executable**: Includes Electron builder config to generate a `.exe`.

## Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Firebase (Mandatory for Cloud Sync)
1. Go to the [Firebase Console](https://console.firebase.google.com/) and create a project.
2. Enable **Firestore Database** and **Authentication** (Google Sign-In).
3. Create a `.env.local` file in the root directory.
4. Copy the keys from your Firebase Web App config into `.env.local`:
```
VITE_FIREBASE_API_KEY="your-api-key"
VITE_FIREBASE_AUTH_DOMAIN="your-app.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="your-project"
VITE_FIREBASE_STORAGE_BUCKET="your-project.appspot.com"
VITE_FIREBASE_MESSAGING_SENDER_ID="your-sender"
VITE_FIREBASE_APP_ID="your-app-id"
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. Build for Web (Vercel/Netlify Deployment)
```bash
npm run build
```
The resulting web app will be placed in the `dist` folder.

### 5. Build Desktop Executable (.exe)
*Note: You must run your terminal as Administrator to generate Windows executables.*
```bash
npm run electron:build
```
