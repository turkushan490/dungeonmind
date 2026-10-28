/** Running inside the DungeonMind Android app (Capacitor adds this to the user agent). */
export const isNative = () => /DungeonMindAndroid/.test(navigator.userAgent);

/** Back to the app's own server picker. */
export const changeServer = () => (location.href = 'https://localhost/?change=1');
