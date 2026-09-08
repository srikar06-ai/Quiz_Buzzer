# Quiz Buzzer V3 — Technical Quiz & Fullscreen Anti-Cheating System

Real-time, microsecond-precision web quiz buzzer application with multi-layered anti-cheating monitoring, presence tracking, and host controls.

## 🚀 Features

- **Microsecond Precision Buzzing**: High-precision timestamp tracking on the server for accurate buzzer rankings.
- **Strict Fullscreen Enforcement & Lock Screen**: Non-dismissible blocking Lock Screen (`z-index: 20000`) whenever fullscreen is lost. Requires browser-verified `fullscreenchange` re-entry.
- **Server-Side Buzz Protection**: Buzz attempts received while a participant is outside fullscreen or violating state are rejected on the server (`buzz_rejected`), preventing DevTools/DOM manipulation bypasses.
- **System UI & Focus Detection**: Captures observable focus shifts (`window.blur` while visible) as `SUSPICIOUS_SYSTEM_UI` alerts on the Host Dashboard.
- **Participant Presence Heartbeat**: Periodic 4-second client heartbeats with automatic 12-second server timeout detection (`HEARTBEAT_TIMEOUT`).
- **Host Control Dashboard**: Live point scoring (+10, +7, +4 quick buttons), manual room freeze, buzzer reset to OFF mode, and host resolution options (`Warn`, `Disqualify`, `Let Go`).

---

## 🔒 Security Architecture & Technical Boundaries

### Explicit Android Notification Shade Boundary
> [!IMPORTANT]
> **Browser Security Limitation**:
> **Browser fullscreen does not provide Android kiosk-mode security. The Android notification shade remains controlled by the operating system and cannot be disabled by JavaScript.**
>
> Normal web browsers running on Android (Chrome, Samsung Internet, Firefox) operate within standard OS webview sandbox rules:
> - A webpage **cannot** block or prevent the physical swipe gesture used to pull down the Android notification panel/control shade.
> - A webpage **cannot** intercept system-level OS gestures or inspect the content of notifications.
> - A webpage **cannot** programmatically enable or control system Airplane Mode or device hardware switches.

### Recommended Proctored Kiosk Solution
If an organization or exam environment requires the Android notification shade itself to be physically inaccessible, the deployment must move from a normal web application to an **Android Native Kiosk Application**:
- **Android Lock Task API**: Invokes `startLockTask()` on managed Android hardware to lock the OS interface, disabling the home button, recent apps, and notification panel completely.
- **WebView Container**: Renders this web app within the locked kiosk shell.

---

## 🛠️ Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v16+ recommended)

### Installation & Run

1. Navigate to the `Backend` directory:
   ```bash
   cd Backend
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open your browser at `http://localhost:3000`.

---

## 📄 License
ISC License
