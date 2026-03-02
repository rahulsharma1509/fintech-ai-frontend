/* eslint-disable no-undef */
// firebase-messaging-sw.js
// Background push message handler (service worker).
// This file must live at /public/firebase-messaging-sw.js so the browser can
// register it from the root scope.
//
// It runs in a service worker context — no DOM, no React.
// Firebase version must match what is installed in package.json.

importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js");

// ── Firebase config is injected at runtime via the SW message channel ──────────
// The main thread sends the config after the SW is installed.
// Until it arrives we cache incoming push payloads and show them when ready.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "FIREBASE_CONFIG") {
    const config = event.data.config;
    if (!firebase.apps.length) {
      firebase.initializeApp(config);
    }
    const messaging = firebase.messaging();

    // Handle background push messages
    messaging.onBackgroundMessage((payload) => {
      const title = payload.notification?.title || "MySupp Support";
      const body  = payload.notification?.body  || "You have a new message.";
      self.registration.showNotification(title, {
        body,
        icon:  "/logo192.png",
        badge: "/logo192.png",
        data:  payload.data || {},
        requireInteraction: false,
      });
    });
  }
});

// Notification click — open or focus the app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
